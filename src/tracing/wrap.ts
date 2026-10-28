import {
  type Attributes,
  INVALID_SPAN_CONTEXT,
  type Span,
  SpanKind,
  type SpanOptions,
  trace,
} from '@opentelemetry/api';
import { finalize, type Observable, tap } from 'rxjs';
import type { ClassifyOptions } from '../errors/classify';
import { recordError } from '../errors/record';
import { SCOPE_NAME } from '../shared/constants';
import { safely } from '../shared/safe';
import { WRAPPED } from '../shared/symbols';
import { copyMethodMetadata } from './copy-metadata';

export interface WrapOptions {
  spanName: string;
  attributes?: Attributes;
  kind?: SpanKind;
  paramAttributes?: { index: number; name: string }[];
  classify: () => ClassifyOptions;
}

export interface ResultHooks {
  /** Called at most once per settlement, before `onFinally`, when the result fails. */
  onError(err: unknown): void;
  /** Called when the result settles: immediately for plain values, on settle for Promises, on complete/error/unsubscribe for Observables. */
  onFinally(): void;
}

function isObservable(value: unknown): value is Observable<unknown> {
  return safely(
    'observable check',
    () =>
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { subscribe?: unknown }).subscribe === 'function' &&
      typeof (value as { pipe?: unknown }).pipe === 'function',
    false,
  );
}

/**
 * Attaches `hooks` to a method's return value without changing what the caller
 * observes: plain values and Observables' emissions pass through, Promises
 * resolve/reject with the same value. Hook failures are swallowed.
 */
export function handleResult<T>(result: T, hooks: ResultHooks): T {
  const onError = (err: unknown) => safely('result onError hook', () => hooks.onError(err), undefined);
  const onFinally = () => safely('result onFinally hook', () => hooks.onFinally(), undefined);

  if (result instanceof Promise) {
    const chained = safely(
      'attach promise hooks',
      () =>
        result.then(
          (value) => {
            onFinally();
            return value;
          },
          (err: unknown) => {
            onError(err);
            onFinally();
            throw err;
          },
        ),
      undefined,
    );
    if (chained) return chained as T;
    onFinally();
    return result;
  }

  if (isObservable(result)) {
    const piped = safely('attach observable hooks', () => result.pipe(tap({ error: onError }), finalize(onFinally)), undefined);
    if (piped) return piped as T;
    onFinally();
    return result;
  }

  onFinally();
  return result;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function paramAttributesOf(params: WrapOptions['paramAttributes'], args: unknown[]): Attributes {
  const attrs: Attributes = {};
  if (!params) return attrs;
  for (const { index, name } of params) {
    const value = args[index];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') attrs[name] = value;
  }
  return attrs;
}

/**
 * Runs `invoke` inside a new active span. `invoke` is called exactly once, its
 * exceptions propagate unchanged, and any tracer failure falls back to running
 * it with a non-recording span.
 */
export function runInSpan<T>(
  spanName: string,
  spanOptions: () => SpanOptions,
  classify: () => ClassifyOptions,
  invoke: (span: Span) => T,
): T {
  let outcome: Outcome<T> | undefined;
  let span: Span | undefined;
  const run = (s: Span) => {
    try {
      outcome = { ok: true, value: invoke(s) };
    } catch (error) {
      outcome = { ok: false, error };
    }
  };

  safely(
    'start span',
    () =>
      trace.getTracer(SCOPE_NAME).startActiveSpan(spanName, spanOptions(), (s: Span) => {
        if (outcome) return;
        span = s;
        run(s);
      }),
    undefined,
  );

  if (!outcome) run(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
  const result = outcome as unknown as Outcome<T>;

  if (!span) {
    if (result.ok) return result.value;
    throw result.error;
  }

  const active = span;
  let ended = false;
  const hooks: ResultHooks = {
    onError: (err) => safely('record error', () => recordError(active, err, classify()), undefined),
    onFinally: () => {
      if (ended) return;
      ended = true;
      safely('end span', () => active.end(), undefined);
    },
  };

  if (!result.ok) {
    hooks.onError(result.error);
    hooks.onFinally();
    throw result.error;
  }
  return handleResult(result.value, hooks);
}

function markWrapped(original: (...a: any[]) => any, wrapper: (...a: any[]) => any): void {
  safely('copy method metadata', () => copyMethodMetadata(original, wrapper), undefined);
  Object.defineProperty(wrapper, WRAPPED, { value: true, configurable: true });
}

export function wrapMethod<F extends (...a: any[]) => any>(original: F, o: WrapOptions): F {
  const wrapper = function (this: unknown, ...args: unknown[]) {
    return runInSpan(
      o.spanName,
      () => ({
        kind: o.kind ?? SpanKind.INTERNAL,
        attributes: { ...o.attributes, ...paramAttributesOf(o.paramAttributes, args) },
      }),
      o.classify,
      () => original.apply(this, args),
    );
  };
  markWrapped(original, wrapper);
  return wrapper as unknown as F;
}

export function wrapForErrorRecording<F extends (...a: any[]) => any>(
  original: F,
  onError: (err: unknown, args: unknown[]) => void,
): F {
  const wrapper = function (this: unknown, ...args: unknown[]) {
    const report = (err: unknown) => safely('error recording hook', () => onError(err, args), undefined);
    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (err) {
      report(err);
      throw err;
    }
    return handleResult(result, { onError: report, onFinally: () => {} });
  };
  markWrapped(original, wrapper);
  return wrapper as unknown as F;
}

export function isWrapped(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as unknown as Record<symbol, unknown>)[WRAPPED] === true;
}
