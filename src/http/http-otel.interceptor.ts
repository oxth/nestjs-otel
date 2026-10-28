import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { context, type Span } from '@opentelemetry/api';
import { getRPCMetadata, RPCType } from '@opentelemetry/core';
import { catchError, type Observable, throwError } from 'rxjs';
import { OTEL_OPTIONS, type ResolvedOtelOptions } from '../module/options';
import { safely } from '../shared/safe';
import { ROOT_SPAN } from '../shared/symbols';
import { applyFailureContext, applyResponseBody, getRootSpan } from './failure-context';
import { NO_CAPTURE_BODY_META } from './no-capture-body.decorator';
import { resolveRoute } from './route';

type AnyFn = (...a: any[]) => any;

/**
 * Global interceptor for HTTP requests: names the server span by route
 * template and records failure context (status, user, redacted body) on it.
 */
@Injectable()
export class HttpOtelInterceptor implements NestInterceptor {
  constructor(
    @Inject(OTEL_OPTIONS) private readonly o: ResolvedOtelOptions,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (safely('read context type', () => ctx.getType(), undefined) !== 'http') return next.handle();
    const http = ctx.switchToHttp();
    const req = safely('read request', () => http.getRequest(), undefined);
    safely('name http span', () => this.nameSpan(req), undefined);
    if (this.o.capture.responseBody) safely('wrap response', () => this.wrapResponse(req, http.getResponse()), undefined);

    return next.handle().pipe(
      catchError((err: unknown) => {
        safely(
          'record http failure',
          () => {
            const noCaptureBody = this.reflector.getAllAndOverride<boolean>(NO_CAPTURE_BODY_META, [
              ctx.getHandler(),
              ctx.getClass(),
            ]);
            applyFailureContext(req, err, this.o, { noCaptureBody: noCaptureBody === true });
          },
          undefined,
        );
        return throwError(() => err);
      }),
    );
  }

  private nameSpan(req: any): void {
    const root = getRootSpan(req);
    // Pin the root on the request, so later lookups don't depend on the active context.
    if (root && req && typeof req === 'object' && !req[ROOT_SPAN] && !req.raw?.[ROOT_SPAN]) req[ROOT_SPAN] = root;
    const route = resolveRoute(req);
    if (!route) return;
    const rpc = getRPCMetadata(context.active());
    if (rpc?.type === RPCType.HTTP) rpc.route = route;
    if (!root) return;
    root.updateName(`${req.method} ${route}`);
    root.setAttribute('http.route', route);
  }

  /** Captures the payload of this one response when its status is ≥ 500. */
  private wrapResponse(req: any, res: any): void {
    const root = getRootSpan(req);
    if (!root || !res) return;
    let captured = false;
    const o = this.o;
    const patch = (name: 'json' | 'send'): void => {
      const original = res[name] as AnyFn | undefined;
      if (typeof original !== 'function') return;
      res[name] = function (this: unknown, ...args: unknown[]) {
        safely(
          'capture response body',
          () => {
            if (captured || statusOf(res) < 500) return;
            captured = true;
            applyResponseBody(root as Span, args[0], o);
          },
          undefined,
        );
        return original.apply(this, args);
      };
    };
    // Express responses have json + send; a Fastify reply has send.
    patch('json');
    patch('send');
  }
}

function statusOf(res: any): number {
  const code = res?.statusCode;
  return typeof code === 'number' ? code : 0;
}
