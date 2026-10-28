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

function onUncaught(err: unknown, origin: string): void {
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
  safely('uncaught error flush', () => void getSdkHandle()?.forceFlush().catch(() => undefined), undefined);
}

/**
 * Records uncaught exceptions / unhandled rejections. Uses only the
 * `uncaughtExceptionMonitor` event, so Node's crash behaviour is unchanged.
 */
export function installProcessErrorMonitor(): void {
  const state = getGlobalState();
  if (state.processMonitorInstalled) return;
  state.processMonitorInstalled = true;
  process.on('uncaughtExceptionMonitor', onUncaught);
}
