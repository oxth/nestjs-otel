import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/db/**/*.db.test.ts'],
    globalSetup: ['test/db/global-setup.ts'],
    setupFiles: ['test/e2e/setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 600_000,
  },
});
