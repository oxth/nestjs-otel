import { getContainerRuntimeClient } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import setupFixture from '../e2e/global-setup';
import { type DbUrls, startDatabases } from './helpers/containers';

declare module 'vitest' {
  export interface ProvidedContext {
    /** `null` when Docker is unavailable (and `REQUIRE_DOCKER` is not `1`): the DB suite is skipped. */
    dbUrls: DbUrls | null;
  }
}

/** Installs and builds the e2e fixture app, then starts Postgres, MySQL, Mongo and Redis containers. */
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  try {
    await getContainerRuntimeClient();
  } catch (err) {
    const why = `Docker is unavailable (${(err as Error).message})`;
    if (process.env.REQUIRE_DOCKER === '1') {
      // Printed as well: vitest 5 can fail to print a global setup error ("code.charCodeAt is not a function").
      console.error(`${why}, and REQUIRE_DOCKER=1`);
      throw new Error(`${why}, and REQUIRE_DOCKER=1`);
    }
    console.warn(`Skipping the database tests: ${why}`);
    project.provide('dbUrls', null);
    return undefined;
  }

  setupFixture();
  const { urls, stop } = await startDatabases();
  project.provide('dbUrls', urls);
  return stop;
}
