import { afterEach } from 'vitest';
import { stopAllApps } from './helpers/spawn-app';

// Tests stop their apps on the happy path; this catches the ones a failing assertion skipped.
afterEach(() => stopAllApps('SIGKILL'));
