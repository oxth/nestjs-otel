import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = join(here, '../..');
export const TMP_DIR = join(here, '.tmp');
/** Fixture sources (committed). */
export const FIXTURE_SRC_DIR = join(here, 'fixture');
/** Installed + compiled copy of the fixture that the tests run. */
export const FIXTURE_DIR = join(TMP_DIR, 'fixture');
