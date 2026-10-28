import { type Span, SpanStatusCode } from '@opentelemetry/api';
import { type ClassifyOptions, classifyError } from './classify';

const MAX_CAUSE_DEPTH = 5;
const recordedErrors = new WeakSet<object>();
const recordedStacks = new WeakMap<Span, Set<string>>();

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

export function hasStackRecorded(span: Span, stack: string): boolean {
  return recordedStacks.get(span)?.has(stack) ?? false;
}

export function markStackRecorded(span: Span, stack: string): void {
  let set = recordedStacks.get(span);
  if (!set) {
    set = new Set();
    recordedStacks.set(span, set);
  }
  set.add(stack);
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
  const message = errorMessage(err);

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
      'exception.stacktrace': stack,
    });
    markStackRecorded(span, stack);
  }
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}
