import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = join(here, '../..');
/**
 * Outside the repo, so nothing in the repo's node_modules can satisfy a dependency the fixture
 * does not declare (pnpm's isolated layout must be exercised as an app would see it).
 */
export const TMP_DIR = join(
  realpathSync(tmpdir()),
  `oxth-nestjs-otel-e2e-${createHash('sha256').update(ROOT_DIR).digest('hex').slice(0, 12)}`,
);
/** Fixture sources (committed). */
export const FIXTURE_SRC_DIR = join(here, 'fixture');
/** Installed + compiled copy of the fixture that the tests run. */
export const FIXTURE_DIR = join(TMP_DIR, 'fixture');
