import { logs, trace } from '@opentelemetry/api';
import { formatStack, recordError } from '../errors/record';
import { SCOPE_NAME } from '../shared/constants';
import { getGlobalState } from '../shared/global-state';
import { safely } from '../shared/safe';
import { getSdkHandle } from './sdk';

const SEVERITY_FATAL = 21;

function describeType(err: unknown): string {
  if (err !== null && typeof err === 'object') return (err as object).constructor?.name || 'Object';
  return typeof err;
}

function describeMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

const FLUSH_TIMEOUT_MS = 2000;
const emitted = new WeakSet<object>();
let pendingFlush: Promise<void | undefined> | undefined;
let lastPrimitive: { value: unknown } | undefined;

function wasEmitted(err: unknown): boolean {
  return err !== null && typeof err === 'object' ? emitted.has(err) : lastPrimitive?.value === err;
}

function markEmitted(err: unknown): void {
  if (err !== null && typeof err === 'object') emitted.add(err);
  else lastPrimitive = { value: err };
}

function record(err: unknown, origin: string): void {
  if (wasEmitted(err)) return;
  markEmitted(err);
  safely(
    'uncaught error span',
    () => {
      const span = trace.getActiveSpan();
      if (!span) return;
      recordError(span, err, { treat4xxAsError: false });
      span.end();
    },
    undefined,
  );
  safely(
    'uncaught error log',
    () => {
      const message = describeMessage(err);
      logs.getLogger(SCOPE_NAME).emit({
        severityNumber: SEVERITY_FATAL,
        severityText: 'FATAL',
        body: message,
        attributes: {
          'exception.type': describeType(err),
          'exception.message': message,
          'exception.stacktrace': formatStack(err),
          'process.uncaught.origin': origin,
        },
      });
    },
    undefined,
  );
}

function onUncaught(err: unknown, origin: string): void {
  record(err, origin);
  safely(
    'uncaught error flush',
    () => {
      // Kept so the fatal handler also waits for this export: a second forceFlush alone
      // resolves early when the first one already took the buffered records in flight.
      pendingFlush = getSdkHandle()?.forceFlush().catch(() => undefined);
    },
    undefined,
  );
}

function printError(err: unknown): void {
  let text: string;
  try {
    text = (err as { stack?: string } | null | undefined)?.stack ?? String(err);
  } catch {
    text = Object.prototype.toString.call(err);
  }
  try {
    process.stderr.write(`${text}\n`);
  } catch {
    // nothing left to do
  }
}

async function flushWithTimeout(): Promise<void> {
  const fresh = getSdkHandle()?.forceFlush();
  if (!fresh) return;
  const flush = Promise.all([pendingFlush, fresh]);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
  });
  try {
    await Promise.race([flush.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registering an `uncaughtException` listener disables Node's own crash, so we
 * reproduce it (print, exit 1) after flushing. Only acts when we are the sole listener.
 */
async function onFatal(err: unknown, origin: string): Promise<void> {
  if (process.listenerCount('uncaughtException') !== 1) return;
  try {
    record(err, origin);
    await flushWithTimeout();
  } catch {
    // fall through to crash
  }
  printError(err);
  process.exit(1);
}

/**
 * Records uncaught exceptions / unhandled rejections and flushes telemetry before the
 * process dies. Never adds an `unhandledRejection` listener.
 */
export function installProcessErrorMonitor(): void {
  const state = getGlobalState();
  if (state.processMonitorInstalled) return;
  state.processMonitorInstalled = true;
  process.on('uncaughtExceptionMonitor', onUncaught);
  process.on('uncaughtException', (err, origin) => void onFatal(err, origin));
}
