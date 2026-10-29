import { KafkaContainer } from '@testcontainers/kafka';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export interface DbUrls {
  postgres: string;
  mysql: string;
  mongo: string;
  redis: string;
  /** Kafka bootstrap brokers, `host:port`. */
  kafka: string;
  amqp: string;
  /** SQS-compatible endpoint (ElasticMQ). */
  sqs: string;
}

const PASSWORD = 'test';
const DATABASE = 'test';

function postgres(): Promise<StartedTestContainer> {
  return (
    new GenericContainer('postgres:17')
      .withEnvironment({ POSTGRES_PASSWORD: PASSWORD, POSTGRES_DB: DATABASE })
      .withExposedPorts(5432)
      // Once for the init server, once for the real one.
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .start()
  );
}

function mysql(): Promise<StartedTestContainer> {
  return (
    new GenericContainer('mysql:8.4')
      .withEnvironment({ MYSQL_ROOT_PASSWORD: PASSWORD, MYSQL_DATABASE: DATABASE })
      .withExposedPorts(3306)
      // The init server skips networking, so a TCP query only succeeds against the real one.
      .withWaitStrategy(
        Wait.forAll([
          Wait.forListeningPorts(),
          Wait.forSuccessfulCommand(`mysql -h127.0.0.1 -uroot -p${PASSWORD} -e "select 1" ${DATABASE}`),
        ]),
      )
      .withStartupTimeout(180_000)
      .start()
  );
}

function mongo(): Promise<StartedTestContainer> {
  return new GenericContainer('mongo:8')
    .withExposedPorts(27017)
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
    .start();
}

function redis(): Promise<StartedTestContainer> {
  return new GenericContainer('redis:8')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
}

const KAFKA_PORT = 9093;

function kafka(): Promise<StartedTestContainer> {
  return new KafkaContainer('confluentinc/cp-kafka:8.0.0').withKraft().start();
}

function rabbitmq(): Promise<StartedTestContainer> {
  return new GenericContainer('rabbitmq:4')
    // `guest` may only log in from localhost, and the mapped port isn't.
    .withEnvironment({ RABBITMQ_DEFAULT_USER: PASSWORD, RABBITMQ_DEFAULT_PASS: PASSWORD })
    .withExposedPorts(5672)
    .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
    .withStartupTimeout(120_000)
    .start();
}

function elasticmq(): Promise<StartedTestContainer> {
  return new GenericContainer('softwaremill/elasticmq-native')
    .withExposedPorts(9324)
    .withWaitStrategy(Wait.forLogMessage(/started in/))
    .start();
}

/**
 * Starts Postgres 17, MySQL 8.4, Mongo 8, Redis 8, Kafka (KRaft), RabbitMQ 4 and ElasticMQ (SQS) in
 * parallel.
 */
export async function startDatabases(): Promise<{ urls: DbUrls; stop(): Promise<void> }> {
  const results = await Promise.allSettled([postgres(), mysql(), mongo(), redis(), kafka(), rabbitmq(), elasticmq()]);
  const started = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const stop = async (): Promise<void> => {
    await Promise.all(started.map((c) => c.stop()));
  };
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) {
    await stop();
    throw failed.reason;
  }
  const [pg, my, mg, rd, kf, mq, sq] = started;
  const at = (c: StartedTestContainer, port: number) => `${c.getHost()}:${c.getMappedPort(port)}`;
  return {
    urls: {
      postgres: `postgres://postgres:${PASSWORD}@${at(pg, 5432)}/${DATABASE}`,
      mysql: `mysql://root:${PASSWORD}@${at(my, 3306)}/${DATABASE}`,
      mongo: `mongodb://${at(mg, 27017)}/${DATABASE}`,
      redis: `redis://${at(rd, 6379)}`,
      kafka: at(kf, KAFKA_PORT),
      amqp: `amqp://${PASSWORD}:${PASSWORD}@${at(mq, 5672)}`,
      sqs: `http://${at(sq, 9324)}`,
    },
    stop,
  };
}
