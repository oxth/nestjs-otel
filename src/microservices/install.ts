import { diag } from '@opentelemetry/api';
import type { ResolvedOtelOptions } from '../module/options';
import { getGlobalState } from '../shared/global-state';
import { safely } from '../shared/safe';
import { patchClients } from './client';
import { patchServers } from './server';

const PKG = '@nestjs/microservices';

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/** Replaced at build time per output format (see tsdown.config.ts); undefined when run from source. */
declare const __OXTH_FORMAT__: 'esm' | 'cjs' | undefined;

/**
 * Loads the app's `@nestjs/microservices` (an optional peer), or undefined when it isn't installed.
 * Resolved from this package like a static import would be, so it is the instance the app uses:
 * `require` in the CJS build (Nest 12 is ESM-only and loads through `require(esm)`, the same
 * module instance a CJS app gets), `import()` otherwise. For CJS Nest 11 through `import()`,
 * `default` is its `exports`.
 */
async function loadMicroservices(): Promise<any> {
  try {
    const mod: any =
      typeof __OXTH_FORMAT__ !== 'undefined' && __OXTH_FORMAT__ === 'cjs'
        ? require('@nestjs/microservices')
        : await import('@nestjs/microservices');
    return mod?.ClientProxy ? mod : (mod?.default ?? mod);
  } catch (err) {
    if (!isNotFound(err)) safely('log', () => diag.warn(`@oxth/nestjs-otel: loading ${PKG} failed`, err), undefined);
    return undefined;
  }
}

/**
 * Patches `@nestjs/microservices` clients and servers once per process. Does nothing when
 * `autoInstrument.microservices` is false or the package is absent. Never rejects.
 */
export async function instrumentMicroservices(opts: ResolvedOtelOptions): Promise<void> {
  try {
    if (opts?.autoInstrument?.microservices === false) return;
    const state = getGlobalState();
    if (state.microservicesPatched) return;
    const ms = await loadMicroservices();
    if (!ms || state.microservicesPatched) return;
    state.microservicesPatched = true;
    patchClients(ms);
    patchServers(ms);
  } catch (err) {
    safely('log', () => diag.warn('@oxth/nestjs-otel: instrument microservices failed', err), undefined);
  }
}

/** Test hook: forgets that the prototypes were patched (callers unpatch them first). */
export function resetMicroservicesPatchStateForTests(): void {
  getGlobalState().microservicesPatched = false;
}
