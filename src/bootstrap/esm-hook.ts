import type { Instrumentation } from '@opentelemetry/instrumentation';
import { safely } from '../shared/safe';

/**
 * The module names the ESM loader hook should intercept: exactly those the instrumentations hook.
 * Wrapping every ESM module is unnecessary, and on Node 22 it can crash a CJS app that loads an
 * ESM-only package (Nest 12) through `require()` (ERR_INTERNAL_ASSERTION in require(esm)).
 */
export function esmHookIncludeList(instrumentations: Instrumentation[]): string[] {
  const names = new Set<string>();
  for (const instrumentation of instrumentations) {
    const definitions = safely(
      'read module definitions',
      () => (instrumentation as { getModuleDefinitions?: () => { name: string }[] }).getModuleDefinitions?.() ?? [],
      [],
    );
    for (const { name } of definitions) if (typeof name === 'string') names.add(name);
  }
  return [...names];
}
