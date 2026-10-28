import { isSpanContextValid, type Span, SpanStatusCode } from '@opentelemetry/api';
import { getDefaultRedactor } from '../redact/redactor';
import { type ClassifyOptions, classifyError } from './classify';

const MAX_CAUSE_DEPTH = 5;
const recordedErrors = new WeakSet<object>();
const recordedStacks = new WeakMap<Span, Set<string>>();
// Stacks recorded per trace, so an error recorded on an inner span isn't recorded again
// when it is logged later from an outer span of the same trace. Bounded: oldest traces drop out,
// and each stack is stored as a short key (see `dedupeKey`).
const MAX_TRACKED_TRACES = 256;
const MAX_STACKS_PER_TRACE = 8;
const MAX_KEY_LENGTH = 2048;
const CAUSE_SEPARATOR = '\nCaused by: ';
const stacksByTrace = new Map<string, string[]>();

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  try {
    return String(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

export function formatStack(err: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    parts.push(depth === 0 ? describe(current) : `Caused by: ${describe(current)}`);
    if (!(current instanceof Error) || current.cause === undefined) break;
    current = current.cause;
  }
  return parts.join('\n');
}

function traceKey(span: Span): string | undefined {
  const ctx = span.spanContext();
  return isSpanContextValid(ctx) ? ctx.traceId : undefined;
}

/**
 * Dedupe key of a stack: its head before the first `Caused by:` (Nest logs `err.stack`, while
 * `recordError` stores the stack followed by its cause chain), capped at 2 KB.
 */
function dedupeKey(stack: string): string {
  const cut = stack.indexOf(CAUSE_SEPARATOR);
  const head = cut === -1 ? stack : stack.slice(0, cut);
  return head.length > MAX_KEY_LENGTH ? head.slice(0, MAX_KEY_LENGTH) : head;
}

/** Whether `stack` (or a stack with the same head) was already recorded on `span` or on any span of its trace. */
export function hasStackRecorded(span: Span, stack: string): boolean {
  const k = dedupeKey(stack);
  if (recordedStacks.get(span)?.has(k)) return true;
  const key = traceKey(span);
  const stacks = key === undefined ? undefined : stacksByTrace.get(key);
  return stacks?.includes(k) ?? false;
}

export function markStackRecorded(span: Span, stack: string): void {
  const k = dedupeKey(stack);
  let set = recordedStacks.get(span);
  if (!set) {
    set = new Set();
    recordedStacks.set(span, set);
  }
  if (set.size < MAX_STACKS_PER_TRACE) set.add(k);

  const key = traceKey(span);
  if (key === undefined) return;
  let stacks = stacksByTrace.get(key);
  if (!stacks) {
    if (stacksByTrace.size >= MAX_TRACKED_TRACES) stacksByTrace.delete(stacksByTrace.keys().next().value!);
    stacks = [];
    stacksByTrace.set(key, stacks);
  }
  if (stacks.includes(k)) return;
  if (stacks.length >= MAX_STACKS_PER_TRACE) stacks.shift();
  stacks.push(k);
}

function errorType(err: unknown): string {
  if (err !== null && typeof err === 'object') return (err as object).constructor?.name || 'Object';
  return typeof err;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return describe(err);
}

export function recordError(span: Span, err: unknown, opts: ClassifyOptions): void {
  const { isError, httpStatus } = classifyError(err, opts);
  const type = errorType(err);
  const { redactString } = getDefaultRedactor();
  const message = redactString(errorMessage(err));

  if (!isError) {
    span.addEvent('exception.handled', {
      'exception.type': type,
      'exception.message': message,
      ...(httpStatus !== undefined && { 'http.response.status_code': httpStatus }),
    });
    span.setAttribute('error.expected', true);
    return;
  }

  const isObject = err !== null && typeof err === 'object';
  if (!isObject || !recordedErrors.has(err)) {
    if (isObject) recordedErrors.add(err);
    const stack = formatStack(err);
    span.addEvent('exception', {
      'exception.type': type,
      'exception.message': message,
      'exception.stacktrace': redactString(stack),
    });
    // Dedupe on the raw stack: that's what a later `logger.error(err.stack)` passes in.
    markStackRecorded(span, stack);
  }
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/** Test hook: size of the per-trace dedupe store. */
export function dedupeStoreStats(): { traces: number; maxStacksPerTrace: number; maxKeyLength: number } {
  let maxStacksPerTrace = 0;
  let maxKeyLength = 0;
  for (const stacks of stacksByTrace.values()) {
    maxStacksPerTrace = Math.max(maxStacksPerTrace, stacks.length);
    for (const s of stacks) maxKeyLength = Math.max(maxKeyLength, s.length);
  }
  return { traces: stacksByTrace.size, maxStacksPerTrace, maxKeyLength };
}
