import { copyMethodMetadata } from '../tracing/copy-metadata';
import { safely } from '../shared/safe';

export type MethodWrapper = (original: (...a: any[]) => any, methodName: string) => (...a: any[]) => any;

const ORIGINAL = Symbol.for('@oxth/nestjs-otel.orm-original');

const ORIGINAL_DESC = Symbol.for('@oxth/nestjs-otel.orm-original-descriptor');

type Marked = ((...a: any[]) => any) & {
  [ORIGINAL]?: (...a: any[]) => any;
  /** The own property descriptor the method had before patching; undefined when it was inherited. */
  [ORIGINAL_DESC]?: PropertyDescriptor;
};

/**
 * Replaces each listed method on `proto` with `wrapper(original, name)`. Absent, non-function and
 * already patched methods are skipped. With `ownOnly`, methods `proto` only inherits are skipped too
 * (for a subclass whose base prototype is patched separately). Returns the names actually patched.
 */
export function patchMethods(
  proto: object | undefined,
  methods: readonly string[],
  wrapper: MethodWrapper,
  opts?: { ownOnly?: boolean },
): string[] {
  const patched: string[] = [];
  if (!proto) return patched;
  for (const name of methods) {
    if (opts?.ownOnly && !Object.hasOwn(proto, name)) continue;
    const original = (proto as Record<string, unknown>)[name];
    if (typeof original !== 'function' || (original as Marked)[ORIGINAL]) continue;
    const ok = safely(
      `patch ${name}`,
      () => {
        const replacement = wrapper(original as (...a: any[]) => any, name);
        safely('copy method metadata', () => copyMethodMetadata(original, replacement), undefined);
        const own = Object.getOwnPropertyDescriptor(proto, name);
        Object.defineProperty(replacement, ORIGINAL, { value: original, configurable: true });
        Object.defineProperty(replacement, ORIGINAL_DESC, { value: own, configurable: true });
        Object.defineProperty(proto, name, { value: replacement, writable: true, configurable: true, enumerable: false });
        return true;
      },
      false,
    );
    if (ok) patched.push(name);
  }
  return patched;
}

/** Restores methods patched on `proto` itself; methods it only inherits are left alone. */
export function unpatchMethods(proto: object | undefined, methods: readonly string[]): void {
  if (!proto) return;
  for (const name of methods) {
    if (!Object.hasOwn(proto, name)) continue;
    const current = (proto as Record<string, unknown>)[name] as Marked | undefined;
    const original = typeof current === 'function' ? current[ORIGINAL] : undefined;
    if (!original) continue;
    const desc = current![ORIGINAL_DESC];
    safely(
      `unpatch ${name}`,
      () => {
        if (desc) Object.defineProperty(proto, name, desc);
        else delete (proto as Record<string, unknown>)[name];
      },
      undefined,
    );
  }
}
