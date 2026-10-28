import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export interface DbUrls {
  postgres: string;
  mysql: string;
  mongo: string;
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

/** Starts Postgres 17, MySQL 8.4 and Mongo 8 in parallel. */
export async function startDatabases(): Promise<{ urls: DbUrls; stop(): Promise<void> }> {
  const results = await Promise.allSettled([postgres(), mysql(), mongo()]);
  const started = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const stop = async (): Promise<void> => {
    await Promise.all(started.map((c) => c.stop()));
  };
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) {
    await stop();
    throw failed.reason;
  }
  const [pg, my, mg] = started;
  const at = (c: StartedTestContainer, port: number) => `${c.getHost()}:${c.getMappedPort(port)}`;
  return {
    urls: {
      postgres: `postgres://postgres:${PASSWORD}@${at(pg, 5432)}/${DATABASE}`,
      mysql: `mysql://root:${PASSWORD}@${at(my, 3306)}/${DATABASE}`,
      mongo: `mongodb://${at(mg, 27017)}/${DATABASE}`,
    },
    stop,
  };
}
