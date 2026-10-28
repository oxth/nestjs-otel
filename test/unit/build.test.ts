import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('build output', () => {
  it.each(['index', 'register', 'pino'])('%s builds as cjs and esm with types', (name) => {
    for (const ext of ['mjs', 'cjs', 'd.mts', 'd.cts']) {
      expect(existsSync(`dist/${name}.${ext}`), `dist/${name}.${ext}`).toBe(true);
    }
  });

  it('package exports map resolves every entry for import and require', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    for (const k of ['.', './register', './pino']) {
      expect(pkg.exports[k].import.default).toMatch(/\.mjs$/);
      expect(pkg.exports[k].require.default).toMatch(/\.cjs$/);
    }
  });
});
