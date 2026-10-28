import { type Span, trace } from '@opentelemetry/api';
import { classifyError } from '../errors/classify';
import { recordError } from '../errors/record';
import type { ResolvedOtelOptions } from '../module/options';
import { serializeBody } from '../redact/redactor';
import { ROOT_SPAN } from '../shared/symbols';

/** Root spans that already carry failure context (guard and interceptor paths can both fire). */
const applied = new WeakSet<Span>();

const PARSED_BODY_TYPES = ['application/json', 'application/x-www-form-urlencoded'];

/** The request's root (server) span: the one stored on the request, else the active span. */
export function getRootSpan(req: any): Span | undefined {
  return req?.[ROOT_SPAN] ?? req?.raw?.[ROOT_SPAN] ?? trace.getActiveSpan();
}

function header(req: any, name: string): string | undefined {
  const v = req?.headers?.[name];
  if (Array.isArray(v)) return v.join(', ');
  return typeof v === 'string' ? v : undefined;
}

/**
 * Records a request failure on the request's root span: error status (the
 * exception event only if no inner span has it), and for real errors the user
 * id and the redacted request body.
 */
export function applyFailureContext(
  req: any,
  err: unknown,
  o: ResolvedOtelOptions,
  flags?: { noCaptureBody?: boolean },
): void {
  const root = getRootSpan(req);
  if (!root) return;
  const { isError } = classifyError(err, o.classify);
  recordError(root, err, o.classify);
  if (!isError || applied.has(root)) return;
  applied.add(root);

  const userId = o.capture.getUserId(req);
  if (userId !== undefined && userId !== null) root.setAttribute('user.id', String(userId));

  if (!o.capture.requestBody || flags?.noCaptureBody) return;
  const contentType = header(req, 'content-type') ?? '';
  if (PARSED_BODY_TYPES.some((t) => contentType.includes(t))) {
    if (req.body === undefined) return;
    const { body, truncated } = serializeBody(o.redactor.redact(req.body), o.capture.maxBodyBytes);
    root.setAttribute('http.request.body', body);
    if (truncated) root.setAttribute('http.request.body.truncated', true);
    return;
  }
  const length = Number(header(req, 'content-length'));
  if (Number.isFinite(length)) root.setAttribute('http.request.body.size', length);
  if (contentType) root.setAttribute('http.request.header.content-type', contentType);
}

/** Puts the redacted, serialized response payload of a failed (≥ 500) response on the root span. */
export function applyResponseBody(root: Span, payload: unknown, o: ResolvedOtelOptions): void {
  const { body, truncated } = serializeBody(o.redactor.redact(payload), o.capture.maxBodyBytes);
  root.setAttribute('http.response.body', body);
  if (truncated) root.setAttribute('http.response.body.truncated', true);
}
