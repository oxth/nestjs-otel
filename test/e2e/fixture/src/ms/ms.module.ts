import { type INestApplication, Module, type Type } from '@nestjs/common';
import { type ClientProxy, ClientsModule, type MicroserviceOptions, Transport } from '@nestjs/microservices';
import { createServer } from 'node:net';
import { firstValueFrom, timeout } from 'rxjs';
import { KAFKA_REQUEST_TOPICS, MS_CLIENT, MsClientService } from './ms-client.service.js';
import { MsController } from './ms.controller.js';
import { UsersMsController } from './users-ms.controller.js';

export type NestTransport = 'tcp' | 'redis' | 'kafka' | 'rmq';

export interface MsSetup {
  module: Type;
  /** Passed to `app.connectMicroservice`; none for SQS (its consumer lives in `SqsModule`). */
  microservice?: MicroserviceOptions;
  /** Resolves once the transport can serve the tests' first request. */
  ready?(app: INestApplication): Promise<void>;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required with TRANSPORT=${process.env.TRANSPORT}`);
  return v;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** Every topic the app produces to, created up front so no consumer waits for auto-creation. */
const KAFKA_TOPICS = [...KAFKA_REQUEST_TOPICS, ...KAFKA_REQUEST_TOPICS.map((t) => `${t}.reply`), 'user.created'];

async function createKafkaTopics(brokers: string[]): Promise<void> {
  const { Kafka, logLevel } = await import('kafkajs');
  const admin = new Kafka({ clientId: 'fixture-admin', brokers, logLevel: logLevel.NOTHING }).admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const topics = KAFKA_TOPICS.filter((t) => !existing.has(t)).map((topic) => ({ topic, numPartitions: 1 }));
    if (topics.length > 0) await admin.createTopics({ topics, waitForLeaders: true });
  } finally {
    await admin.disconnect();
  }
}

/**
 * Kafka consumers join their groups after `connect()` returns, and a request sent before the client
 * has its reply partition fails. Ping until a round trip works.
 */
async function kafkaReady(app: INestApplication): Promise<void> {
  const client = app.get<ClientProxy>(MS_CLIENT);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await firstValueFrom(client.send('ms.ping', {}).pipe(timeout(3_000)));
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function transportOptions(transport: NestTransport): Promise<{
  server: MicroserviceOptions;
  client: Record<string, unknown>;
  ready?: MsSetup['ready'];
}> {
  if (transport === 'tcp') {
    const options = { host: '127.0.0.1', port: await freePort() };
    return { server: { transport: Transport.TCP, options }, client: { transport: Transport.TCP, options } };
  }
  if (transport === 'redis') {
    const url = new URL(env('REDIS_URL'));
    const options = { host: url.hostname, port: Number(url.port) };
    return { server: { transport: Transport.REDIS, options }, client: { transport: Transport.REDIS, options } };
  }
  if (transport === 'kafka') {
    const brokers = env('KAFKA_BROKERS').split(',');
    await createKafkaTopics(brokers);
    // One group per process: a killed app never leaves its group, and a new member of that group would
    // wait for the dead one's session to time out before it gets partitions.
    const groupId = `fixture-${process.pid}-${Date.now()}`;
    const options = (clientId: string) => ({
      client: { clientId, brokers, retry: { retries: 10 } },
      consumer: { groupId },
    });
    return {
      server: { transport: Transport.KAFKA, options: options('fixture') },
      client: { transport: Transport.KAFKA, options: options('fixture') },
      ready: kafkaReady,
    };
  }
  if (transport === 'rmq') {
    // RabbitMQ 4 refuses transient non-exclusive queues.
    const options = { urls: [env('AMQP_URL')], queue: 'fixture_ms', queueOptions: { durable: true } };
    return { server: { transport: Transport.RMQ, options }, client: { transport: Transport.RMQ, options } };
  }
  throw new Error(`unknown TRANSPORT ${transport as string}`);
}

/**
 * A static module (so `MsClientService` and `UsersMsController` are auto-traced) for
 * `TRANSPORT=tcp|redis|kafka|rmq`: the HTTP routes call a client pointed at this app's own microservice.
 */
export async function createMsModule(transport: NestTransport): Promise<MsSetup> {
  const { server, client, ready } = await transportOptions(transport);

  @Module({
    imports: [ClientsModule.register([{ name: MS_CLIENT, ...client } as never])],
    controllers: [MsController, UsersMsController],
    providers: [MsClientService],
  })
  class MsModule {}
  return { module: MsModule, microservice: server, ready };
}
