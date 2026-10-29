import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { type FlatSpan, type OtlpReceiver, startOtlpReceiver } from '../e2e/helpers/otlp-receiver';
import { spawnApp } from '../e2e/helpers/spawn-app';

const ERROR = 2;
const SERVER = 2;
const CLIENT = 3;
const PRODUCER = 4;
const CONSUMER = 5;
const SECRET = 'hunter2-SECRET';
/** Broker round trips (Kafka consumer groups, SQS long polling) take longer than in-process TCP. */
const WAIT_MS = 20_000;

const urls = inject('dbUrls');

type Transport = 'tcp' | 'redis' | 'kafka' | 'rmq' | 'sqs';

const SYSTEM: Record<Transport, string> = {
  tcp: 'tcp',
  redis: 'redis',
  kafka: 'kafka',
  rmq: 'rabbitmq',
  sqs: 'aws_sqs',
};

const scenarios: [Transport, 'esm' | 'cjs'][] = [
  ['tcp', 'esm'],
  ['tcp', 'cjs'],
  ['redis', 'esm'],
  ['kafka', 'esm'],
  ['rmq', 'esm'],
  ['sqs', 'esm'],
];

function transportEnv(transport: Transport): Record<string, string> {
  const env: Record<string, string> = { TRANSPORT: transport };
  if (transport === 'redis') env.REDIS_URL = urls!.redis;
  if (transport === 'kafka') env.KAFKA_BROKERS = urls!.kafka;
  if (transport === 'rmq') env.AMQP_URL = urls!.amqp;
  if (transport === 'sqs') env.SQS_ENDPOINT = urls!.sqs;
  return env;
}

let receiver: OtlpReceiver;
beforeEach(async () => {
  receiver = await startOtlpReceiver();
});
afterEach(async () => {
  await receiver.close();
});

/** True when `ancestor` is on `span`'s parent chain (through spans received so far). */
function isAncestor(ancestor: FlatSpan, span: FlatSpan): boolean {
  const byId = new Map(receiver.spans().map((s) => [s.spanId, s]));
  let parent = span.parentSpanId;
  for (let hops = 0; parent && hops < 64; hops++) {
    if (parent === ancestor.spanId) return true;
    parent = byId.get(parent)?.parentSpanId;
  }
  return false;
}

/**
 * Waits until `ancestor` is on `span`'s parent chain: the spans in between (broker consumer spans,
 * the HTTP server span) end later than the handler and may arrive in a later export batch.
 */
async function expectChained(ancestor: FlatSpan, span: FlatSpan): Promise<void> {
  await receiver.waitFor(() => isAncestor(ancestor, span), WAIT_MS).catch(() => {
    throw new Error(`${ancestor.name} is not an ancestor of ${span.name}`);
  });
}

const isRedisSpan = (s: FlatSpan): boolean => (s.attributes['db.system.name'] ?? s.attributes['db.system']) === 'redis';

describe.skipIf(!urls)('microservices', { timeout: 120_000 }, () => {
  describe.each(scenarios)('%s via %s', (transport, entry) => {
    const start = () =>
      spawnApp({
        entry,
        preload: entry === 'esm',
        receiver,
        env: transportEnv(transport),
        startTimeoutMs: 90_000,
      });
    const find = (pred: (s: FlatSpan) => boolean) => () => receiver.spans().find(pred);
    const wait = (pred: (s: FlatSpan) => boolean) => receiver.waitFor(find(pred), WAIT_MS);
    /** The span of the handler that receives `POST /ms/events` / `POST /ms/fail`. */
    const eventHandler = transport === 'sqs' ? 'OrdersSqsHandler.handle' : 'UsersMsController.created';
    const failHandler = transport === 'sqs' ? 'OrdersSqsHandler.handle' : 'UsersMsController.fail';

    it.skipIf(transport === 'sqs')('trace chain: service → send → handler', async () => {
      const app = await start();
      const res = await app.get('/ms/users/1');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 1, name: 'user-1' });

      const svc = await wait((s) => s.name === 'MsClientService.get');
      // kind: the kafkajs producer span is named `send users.get` too.
      const send = await wait((s) => s.name === 'send users.get' && s.kind === CLIENT && s.traceId === svc.traceId);
      const handler = await wait((s) => s.name === 'UsersMsController.get' && s.traceId === svc.traceId);
      expect(send.parentSpanId).toBe(svc.spanId);
      expect(send.attributes).toMatchObject({
        'messaging.system': SYSTEM[transport],
        'messaging.destination.name': 'users.get',
        'messaging.operation.type': 'send',
        'nestjs.microservice.kind': 'message',
      });
      expect(handler.kind).toBe(SERVER);
      expect(handler.attributes).toMatchObject({
        'messaging.system': SYSTEM[transport],
        'messaging.destination.name': 'users.get',
        'messaging.operation.type': 'process',
        'nestjs.microservice.kind': 'message',
        'nestjs.microservice.pattern': 'users.get',
      });
      // TCP and Redis carry the context in our envelope; Kafka and RabbitMQ through the broker
      // instrumentation's producer and consumer spans, which sit in between.
      if (transport === 'tcp' || transport === 'redis') expect(handler.parentSpanId).toBe(send.spanId);
      else await expectChained(send, handler);
      const server = await wait((s) => s.name.startsWith('GET') && s.kind === SERVER && s.traceId === svc.traceId);
      await expectChained(server, svc);

      if (transport === 'redis') {
        await app.stop();
        // Command spans carry a statement, and it is the command name only: no keys, no values.
        const statements = receiver
          .spans()
          .filter(isRedisSpan)
          .flatMap((s) => ['db.statement', 'db.query.text'].map((k) => s.attributes[k]))
          .filter((v) => v !== undefined);
        expect(statements.length).toBeGreaterThan(0);
        for (const v of statements) expect(String(v)).toMatch(/^[a-z]+$/i);
      }
    });

    it('event chain: emit → event handler', async () => {
      const app = await start();
      expect((await app.post('/ms/events', { name: 'a' })).status).toBe(202);
      if (transport === 'sqs') {
        const svc = await wait((s) => s.name === 'SqsClientService.created');
        const handler = await wait((s) => s.name === eventHandler && s.traceId === svc.traceId);
        expect(handler.kind).toBe(CONSUMER);
        expect(handler.attributes).toMatchObject({
          'messaging.system': 'aws_sqs',
          'messaging.destination.name': 'orders',
          'messaging.operation.type': 'process',
        });
        await expectChained(svc, handler);
        return;
      }
      const svc = await wait((s) => s.name === 'MsClientService.created');
      const emit = await wait((s) => s.name === 'emit user.created' && s.traceId === svc.traceId);
      const handler = await wait((s) => s.name === eventHandler && s.traceId === emit.traceId);
      expect(emit.kind).toBe(PRODUCER);
      expect(emit.parentSpanId).toBe(svc.spanId);
      expect(handler.kind).toBe(CONSUMER);
      expect(handler.attributes).toMatchObject({
        'messaging.system': SYSTEM[transport],
        'messaging.destination.name': 'user.created',
        'nestjs.microservice.kind': 'event',
      });
      await expectChained(emit, handler);
    });

    it('secret never leaks on success', async () => {
      const app = await start();
      expect((await app.post('/ms/events', { name: 'a', password: SECRET })).status).toBe(202);
      const handler = await wait((s) => s.name === eventHandler);
      await app.stop();
      expect(handler.status.code).not.toBe(ERROR);
      expect(handler.attributes['nestjs.microservice.data']).toBeUndefined();
      expect(JSON.stringify(receiver.spans())).not.toContain(SECRET);
    });

    it('secret never leaks on failure: handler span holds the redacted payload', async () => {
      const app = await start();
      const res = await app.post('/ms/fail', { name: 'a', password: SECRET });
      expect(res.status).toBe(transport === 'sqs' ? 202 : 500);
      const handler = await wait((s) => s.name === failHandler && s.status.code === ERROR);
      await app.stop();
      expect(String(handler.attributes['nestjs.microservice.data'])).toContain('[REDACTED]');
      expect(JSON.stringify(receiver.spans())).not.toContain(SECRET);
    });

    it.runIf(transport === 'redis' && entry === 'esm')('redis: idle server records no spans', async () => {
      const app = await start();
      await new Promise((r) => setTimeout(r, 3_000));
      // Metrics prove the exporter is live, so no spans means none were recorded.
      await receiver.waitFor(() => receiver.metricNames().length > 0, WAIT_MS);
      await app.stop();
      expect(receiver.spans().filter(isRedisSpan)).toEqual([]);
    });

    it('handler metrics exported', async () => {
      const app = await start();
      if (transport === 'sqs') expect((await app.post('/ms/events', { name: 'a' })).status).toBe(202);
      else expect((await app.get('/ms/users/1')).status).toBe(200);
      const destination = transport === 'sqs' ? 'orders' : 'users.get';
      const point = await receiver.waitFor(
        () =>
          receiver
            .metricPoints('messaging.process.duration')
            .find((p) => p.attributes['messaging.destination.name'] === destination),
        WAIT_MS,
      );
      expect(point.attributes).toMatchObject({
        'messaging.system': SYSTEM[transport],
        'messaging.operation.name': 'process',
      });
      await app.stop();
    });
  });
});
