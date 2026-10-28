import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
].flatMap((name) => [name, new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`)]);

export default defineConfig({
  entry: ['src/index.ts', 'src/register.ts', 'src/pino.ts'],
  // `__OXTH_FORMAT__` lets format-specific code (the ESM loader hook, the CJS require.cache
  // check) be dropped from the other build instead of relying on `import.meta` detection,
  // which tsdown always shims in CJS output.
  format: {
    esm: { define: { __OXTH_FORMAT__: '"esm"' } },
    cjs: { define: { __OXTH_FORMAT__: '"cjs"' } },
  },
  dts: true,
  platform: 'node',
  target: 'node22',
  clean: true,
  external,
  outExtensions: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.mjs',
    dts: format === 'cjs' ? '.d.cts' : '.d.mts',
  }),
});
