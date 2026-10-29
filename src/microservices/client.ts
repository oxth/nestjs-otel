import { type Context, context, type Span, SpanKind, trace } from '@opentelemetry/api';
import { Observable, type Subscription } from 'rxjs';
import { recordError } from '../errors/record';
import { type MethodWrapper, patchMethods, unpatchMethods } from '../orm/patch';
import { injectContext } from '../propagation/helpers';
import { PACKAGE_VERSION, SCOPE_NAME } from '../shared/constants';
import { safely } from '../shared/safe';
import { getClassifyDefaults } from '../tracing/decorators';
import { patternToString, systemOfClient } from './pattern';

type Kind = 'message' | 'event';

const PROXY_METHODS = ['send', 'emit'] as const;
const ENVELOPE_METHODS = ['publish', 'dispatchEvent'] as const;
/** Clients whose packets carry `metadata` on the wire as is (JSON socket / JSON over pub/sub). */
const ENVELOPE_CLIENTS = ['ClientTCP', 'ClientRedis'] as const;

const protoOf = (ms: any, name: string): object | undefined =>
  safely(`microservices ${name}`, () => ms?.[name]?.prototype, undefined);

function startClientSpan(client: object, pattern: unknown, kind: Kind, parent: Context): Span | undefined {
  return safely(
    'start client span',
    () => {
      const destination = patternToString(pattern);
      return trace.getTracer(SCOPE_NAME, PACKAGE_VERSION).startSpan(
        `${kind === 'message' ? 'send' : 'emit'} ${destination}`,
        {
          kind: kind === 'message' ? SpanKind.CLIENT : SpanKind.PRODUCER,
          attributes: {
            'messaging.system': systemOfClient(client),
            'messaging.destination.name': destination,
            'messaging.operation.type': 'send',
            'nestjs.microservice.kind': kind,
          },
        },
        parent,
      );
    },
    undefined,
  );
}

/** Ends `span` once; records `err` first when given. */
function finisher(span: Span | undefined): (err?: { error: unknown }) => void {
  let done = false;
  return (failure) => {
    if (done || !span) return;
    done = true;
    safely(
      'end client span',
      () => {
        if (failure) recordError(span, failure.error, getClassifyDefaults());
        span.end();
      },
      undefined,
    );
  };
}

/**
 * `send()` is cold: the span starts on subscription, in the context active when `send()` was
 * called, so an Observable subscribed later or elsewhere still parents correctly. Values, errors and
 * completion reach the subscriber in that same caller context (not the socket's). A teardown before
 * any value and before complete or error (unsubscribe, `timeout()`) marks the span
 * `nestjs.microservice.cancelled`; `firstValueFrom`/`take(1)` unsubscribe inside `next`, after the reply.
 */
const sendWrapper: MethodWrapper = (original) =>
  function (this: any, pattern: unknown, data: unknown, ...rest: unknown[]) {
    // Cold: calling it does no work, subscribing does (in the span's context, below).
    const source = original.call(this, pattern, data, ...rest);
    const captured = safely('capture context', () => context.active(), undefined);
    if (!captured || typeof source?.subscribe !== 'function') return source;
    return new Observable((subscriber) => {
      const span = startClientSpan(this, pattern, 'message', captured);
      const finish = finisher(span);
      const spanCtx = span ? trace.setSpan(captured, span) : captured;
      // A reply arrived, or the stream completed or failed: a later teardown is not a cancellation.
      let settled = false;
      let inner: Subscription | undefined;
      try {
        inner = context.with(spanCtx, () =>
          source.subscribe({
            next: (v: unknown) => {
              settled = true;
              context.with(captured, () => subscriber.next(v));
            },
            error: (error: unknown) => {
              settled = true;
              finish({ error });
              context.with(captured, () => subscriber.error(error));
            },
            complete: () => {
              settled = true;
              finish();
              context.with(captured, () => subscriber.complete());
            },
          }),
        );
      } catch (error) {
        settled = true;
        finish({ error });
        throw error;
      }
      return () => {
        inner?.unsubscribe();
        if (!settled && span) {
          safely('mark cancelled', () => span.setAttribute('nestjs.microservice.cancelled', true), undefined);
        }
        finish();
      };
    });
  };

/** `emit()` connects eagerly, so its span starts at the call and ends when the dispatch settles. */
const emitWrapper: MethodWrapper = (original) =>
  function (this: any, pattern: unknown, data: unknown, ...rest: unknown[]) {
    const parent = safely('capture context', () => context.active(), undefined);
    const span = parent ? startClientSpan(this, pattern, 'event', parent) : undefined;
    if (!span || !parent) return original.call(this, pattern, data, ...rest);
    const finish = finisher(span);
    let result: any;
    try {
      result = context.with(trace.setSpan(parent, span), () => original.call(this, pattern, data, ...rest));
    } catch (error) {
      finish({ error });
      throw error;
    }
    safely(
      'observe emit',
      () => {
        if (typeof result?.subscribe !== 'function') return finish();
        result.subscribe({ error: (error: unknown) => finish({ error }), complete: () => finish() });
      },
      undefined,
    );
    return result;
  };

const PLAIN_PROTOS = new Set<unknown>([Object.prototype, null]);

/**
 * Adds the active trace context to `packet.metadata` (created when nullish, extended without
 * overwriting when a plain object, left alone otherwise). `pattern` and `data` are never touched.
 */
function injectIntoPacket(packet: unknown): void {
  safely(
    'inject packet metadata',
    () => {
      if (packet === null || typeof packet !== 'object') return;
      const p = packet as { metadata?: unknown };
      const existing = p.metadata;
      if (existing === undefined || existing === null) {
        const carrier = injectContext({});
        if (Object.keys(carrier).length > 0) p.metadata = carrier;
        return;
      }
      if (typeof existing !== 'object' || !PLAIN_PROTOS.has(Object.getPrototypeOf(existing))) return;
      const carrier = injectContext({});
      const target = existing as Record<string, unknown>;
      for (const [k, v] of Object.entries(carrier)) if (!Object.hasOwn(target, k)) target[k] = v;
    },
    undefined,
  );
}

const envelopeWrapper: MethodWrapper = (original) =>
  function (this: any, packet: unknown, ...rest: unknown[]) {
    injectIntoPacket(packet);
    return original.call(this, packet, ...rest);
  };

export function patchClients(ms: any): void {
  safely(
    'patch microservice clients',
    () => {
      const proxy = protoOf(ms, 'ClientProxy');
      patchMethods(proxy, ['send'], sendWrapper);
      patchMethods(proxy, ['emit'], emitWrapper);
      for (const name of ENVELOPE_CLIENTS) patchMethods(protoOf(ms, name), ENVELOPE_METHODS, envelopeWrapper);
    },
    undefined,
  );
}

export function unpatchClients(ms: any): void {
  safely(
    'unpatch microservice clients',
    () => {
      unpatchMethods(protoOf(ms, 'ClientProxy'), PROXY_METHODS);
      for (const name of ENVELOPE_CLIENTS) unpatchMethods(protoOf(ms, name), ENVELOPE_METHODS);
    },
    undefined,
  );
}
