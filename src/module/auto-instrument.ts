import { ModuleRef, type ModulesContainer } from '@nestjs/core';
import { applyFailureContext } from '../http/failure-context';
import { NO_CAPTURE_BODY_META } from '../http/no-capture-body.decorator';
import { safely } from '../shared/safe';
import { getClassifyDefaults, getSpanParamAttributes, NO_TRACE_META, TRACE_META } from '../tracing/decorators';
import { isWrapped, wrapForErrorRecording, wrapMethod } from '../tracing/wrap';
import { OTEL_INSTRUMENTED, type ResolvedOtelOptions } from './options';

type Role = 'controller' | 'provider' | 'guard' | 'interceptor' | 'pipe' | 'filter';
type AnyFn = (...a: any[]) => any;

const LIFECYCLE_HOOKS = new Set([
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);

/** `canActivate` functions that already report errors to the root span. */
const errorRecording = new WeakSet<AnyFn>();

/**
 * Options of the most recent `instrumentApplication` call. Guard wrappers read
 * them lazily: prototypes are patched once per process, but a later app (tests,
 * re-bootstraps) may run with different options.
 */
let current: ResolvedOtelOptions | undefined;

interface ModuleLike {
  metatype?: unknown;
  token?: string;
  controllers: Map<unknown, WrapperLike>;
  providers: Map<unknown, WrapperLike>;
  injectables: Map<unknown, WrapperLike>;
}

interface WrapperLike {
  metatype?: unknown;
  inject?: unknown;
  isFactory?: boolean;
}

function isClass(v: unknown): v is Function & { prototype: object } {
  return typeof v === 'function' && typeof (v as { prototype?: unknown }).prototype === 'object' && v.prototype !== null;
}

function matches(name: string, patterns: (string | RegExp)[]): boolean {
  return patterns.some((p) => {
    if (typeof p === 'string') return p === name;
    p.lastIndex = 0;
    return p.test(name);
  });
}

function hasMeta(key: string, target: unknown): boolean {
  return safely('read metadata', () => Reflect.getMetadata(key, target as object) === true, false);
}

/**
 * True for modules created by `forRoot()`/`register()`-style dynamic module
 * objects. Nest 11 and 12 both keep the dynamic metadata in the container,
 * keyed by the module's token.
 */
function isDynamicModule(mod: ModuleLike): boolean {
  return safely(
    'detect dynamic module',
    () => {
      const container = (mod as unknown as { container?: { getDynamicMetadataByToken?(t: string): unknown } }).container;
      if (!container?.getDynamicMetadataByToken || mod.token === undefined) return false;
      return container.getDynamicMetadataByToken(mod.token) !== undefined;
    },
    false,
  );
}

function isInternalModule(mod: ModuleLike): boolean {
  const name = (mod.metatype as { name?: string } | undefined)?.name;
  return name === 'InternalCoreModule' || mod.providers.has(OTEL_INSTRUMENTED);
}

function roleOf(cls: Function & { prototype: object }, isController: boolean): Role {
  if (isController) return 'controller';
  const proto = cls.prototype as Record<string, unknown>;
  if (typeof proto.canActivate === 'function') return 'guard';
  if (typeof proto.intercept === 'function') return 'interceptor';
  if (typeof proto.transform === 'function') return 'pipe';
  if (typeof proto.catch === 'function') return 'filter';
  return 'provider';
}

function roleEnabled(role: Role, o: ResolvedOtelOptions): boolean {
  const a = o.autoInstrument;
  switch (role) {
    case 'controller':
      return a.controllers;
    case 'provider':
      return a.providers;
    case 'guard':
      return a.guards;
    case 'interceptor':
      return a.interceptors;
    case 'pipe':
      return a.pipes;
    case 'filter':
      return a.filters;
  }
}

/** Methods visible on `cls` instances, each with the prototype that defines it (most-derived wins). */
function collectMethods(cls: Function & { prototype: object }): { name: string; fn: AnyFn; owner: object }[] {
  const out: { name: string; fn: AnyFn; owner: object }[] = [];
  const seen = new Set<string>();
  for (let proto: object | null = cls.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (name === 'constructor' || LIFECYCLE_HOOKS.has(name)) continue;
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || d.get || d.set || typeof d.value !== 'function') continue;
      out.push({ name, fn: d.value as AnyFn, owner: proto });
    }
  }
  return out;
}

function install(cls: Function & { prototype: object }, name: string, fn: AnyFn): void {
  Object.defineProperty(cls.prototype, name, { value: fn, writable: true, configurable: true, enumerable: false });
}

function guardErrorHandler(err: unknown, args: unknown[]): void {
  safely(
    'record guard error',
    () => {
      const ctx = args[0] as
        | { getType?(): string; switchToHttp?(): { getRequest(): unknown }; getHandler?(): unknown; getClass?(): unknown }
        | undefined;
      if (!current || ctx?.getType?.() !== 'http' || !ctx.switchToHttp) return;
      // Same precedence as Reflector.getAllAndOverride: handler, then class.
      const noCaptureBody = [ctx.getHandler?.(), ctx.getClass?.()].some(
        (t) => t !== undefined && hasMeta(NO_CAPTURE_BODY_META, t),
      );
      applyFailureContext(ctx.switchToHttp().getRequest(), err, current, { noCaptureBody });
    },
    undefined,
  );
}

function instrumentClass(
  cls: Function & { prototype: object },
  role: Role,
  enabled: boolean,
  wrapped: string[],
): void {
  const className = cls.name;
  for (const { name, fn, owner } of collectMethods(cls)) {
    if (hasMeta(NO_TRACE_META, fn)) continue;
    const isCanActivate = role === 'guard' && name === 'canActivate';
    if (isCanActivate && errorRecording.has(fn)) continue;

    let next = fn;
    if ((enabled || hasMeta(TRACE_META, fn)) && !isWrapped(fn)) {
      next = wrapMethod(fn, {
        spanName: `${className}.${name}`,
        attributes: { 'code.namespace': className, 'code.function': name },
        paramAttributes: safely('read span attributes', () => getSpanParamAttributes(owner, name), undefined),
        classify: getClassifyDefaults,
      });
      wrapped.push(`${className}.${name}`);
    }
    // Guards run before interceptors, so their errors are reported to the root span here.
    if (isCanActivate) {
      next = wrapForErrorRecording(next, guardErrorHandler);
      errorRecording.add(next);
    }
    if (next !== fn) install(cls, name, next);
  }
}

/**
 * Patches the prototypes of the application's controllers and providers so
 * their methods run in `Class.method` spans. Call it before routes are bound
 * (`OtelModule` runs it from a provider factory during instantiation).
 */
export function instrumentApplication(container: ModulesContainer, opts: ResolvedOtelOptions): { wrapped: string[] } {
  current = opts;
  const wrapped: string[] = [];
  const { include, exclude } = opts.autoInstrument;

  for (const mod of container.values() as IterableIterator<ModuleLike>) {
    safely(
      'instrument module',
      () => {
        if (isInternalModule(mod)) return;
        const skipModule = isDynamicModule(mod);
        const groups: [Map<unknown, WrapperLike>, boolean][] = [
          [mod.controllers, true],
          [mod.providers, false],
          [mod.injectables, false],
        ];
        for (const [wrappers, isController] of groups) {
          for (const wrapper of wrappers.values()) {
            const cls = wrapper.metatype;
            if (!isClass(cls) || wrapper.inject || wrapper.isFactory) continue;
            if (cls === mod.metatype || cls === ModuleRef) continue;
            const name = cls.name;
            if (!name || matches(name, exclude) || hasMeta(NO_TRACE_META, cls)) continue;
            const forced = hasMeta(TRACE_META, cls) || matches(name, include);
            const role = roleOf(cls, isController);
            const enabled = forced || (!skipModule && roleEnabled(role, opts));
            safely('instrument class', () => instrumentClass(cls, role, enabled, wrapped), undefined);
          }
        }
      },
      undefined,
    );
  }
  return { wrapped };
}
