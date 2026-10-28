import { register as registerHooks } from 'node:module';
import { readBootstrapConfig } from './bootstrap/config';
import { startSdk } from './bootstrap/sdk';
import { getGlobalState } from './shared/global-state';
import { safely } from './shared/safe';

/** Replaced at build time per output format (see tsdown.config.ts). */
declare const __OXTH_FORMAT__: 'esm' | 'cjs';

const NEST_CORE_PATH = /@nestjs[\\/]core[\\/]/;
const LATE_WARNING = '@oxth/nestjs-otel: register was loaded after @nestjs/core; load it first (see README)';

function warnIfLoadedLate(): void {
  const state = getGlobalState();
  if (state.warned.has('register-late')) return;
  if (!Object.keys(require.cache).some((path) => NEST_CORE_PATH.test(path))) return;
  state.warned.add('register-late');
  process.stderr.write(`${LATE_WARNING}\n`);
}

safely(
  'register',
  () => {
    const state = getGlobalState();
    if (state.registered) return;
    state.registered = true;
    if (__OXTH_FORMAT__ === 'esm') {
      registerHooks('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
    } else {
      warnIfLoadedLate();
    }
    startSdk(readBootstrapConfig(process.env));
  },
  undefined,
);
