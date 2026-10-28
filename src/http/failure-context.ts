import { type Span, trace } from '@opentelemetry/api';
import { recordError } from '../errors/record';
import type { ResolvedOtelOptions } from '../module/options';
import { ROOT_SPAN } from '../shared/symbols';

/** The request's root (server) span: the one stored on the request, else the active span. */
export function getRootSpan(req: any): Span | undefined {
  return req?.[ROOT_SPAN] ?? req?.raw?.[ROOT_SPAN] ?? trace.getActiveSpan();
}

/** Records a request failure on the request's root span. */
export function applyFailureContext(
  req: any,
  err: unknown,
  o: ResolvedOtelOptions,
  _flags?: { noCaptureBody?: boolean },
): void {
  const root = getRootSpan(req);
  if (!root) return;
  recordError(root, err, o.classify);
}
