import { copyMethodMetadata } from '../tracing/copy-metadata';
import { safely } from '../shared/safe';

export type MethodWrapper = (original: (...a: any[]) => any, methodName: string) => (...a: any[]) => any;

const ORIGINAL = Symbol.for('@oxth/nestjs-otel.orm-original');

type Marked = ((...a: any[]) => any) & { [ORIGINAL]?: (...a: any[]) => any };

/**
 * Replaces each listed method on `proto` with `wrapper(original, name)`. Absent, non-function and
 * already patched methods are skipped. Returns the names actually patched.
 */
export function patchMethods(proto: object | undefined, methods: readonly string[], wrapper: MethodWrapper): string[] {
  const patched: string[] = [];
  if (!proto) return patched;
  for (const name of methods) {
    const original = (proto as Record<string, unknown>)[name];
    if (typeof original !== 'function' || (original as Marked)[ORIGINAL]) continue;
    const ok = safely(
      `patch ${name}`,
      () => {
        const replacement = wrapper(original as (...a: any[]) => any, name);
        safely('copy method metadata', () => copyMethodMetadata(original, replacement), undefined);
        Object.defineProperty(replacement, ORIGINAL, { value: original, configurable: true });
        Object.defineProperty(proto, name, { value: replacement, writable: true, configurable: true, enumerable: false });
        return true;
      },
      false,
    );
    if (ok) patched.push(name);
  }
  return patched;
}

export function unpatchMethods(proto: object | undefined, methods: readonly string[]): void {
  if (!proto) return;
  for (const name of methods) {
    const current = (proto as Record<string, unknown>)[name] as Marked | undefined;
    const original = typeof current === 'function' ? current[ORIGINAL] : undefined;
    if (!original) continue;
    safely(
      `unpatch ${name}`,
      () => Object.defineProperty(proto, name, { value: original, writable: true, configurable: true, enumerable: false }),
      undefined,
    );
  }
}
