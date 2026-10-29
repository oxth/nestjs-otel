import { type Attributes, context, type Span, SpanKind } from '@opentelemetry/api';
import { classifyError } from '../errors/classify';
import { errorType } from '../errors/record';
import { PROCESS_DURATION_BUCKETS } from '../queue/process-job';
import { getDefaultRedactor, serializeBody } from '../redact/redactor';
import { instrumentsPerMeterProvider } from '../shared/instruments';
import { safely } from '../shared/safe';
import { getClassifyDefaults } from '../tracing/decorators';
import type { CallDescription, WrapOptions } from '../tracing/wrap';
import { findRpcContext, patternToString, RPC_CONTEXT_KEY, systemOfContext } from './pattern';
import { getMicroservicesSettings } from './settings';

/** `PATTERN_METADATA` / `PATTERN_HANDLER_METADATA` in `@nestjs/microservices/constants`. */
const PATTERN_METADATA = 'microservices:pattern';
const PATTERN_HANDLER_METADATA = 'microservices:handler_type';
/** `PatternHandler.EVENT`; anything else is a message (request/response) handler. */
const EVENT_HANDLER = 2;

const instruments = instrumentsPerMeterProvider((meter) => ({
  duration: meter.createHistogram('messaging.process.duration', {
    unit: 's',
    advice: { explicitBucketBoundaries: PROCESS_DURATION_BUCKETS },
  }),
  errors: meter.createCounter('nestjs.microservice.handler.errors'),
}));

/**
 * The RPC context: the last argument whose class is a known transport context, else the one the
 * `Server.addHandler` patch put in the active context (Nest omits it without `@Ctx()`).
 */
function findContext(args: unknown[]): unknown {
  return findRpcContext(args) ?? context.active().getValue(RPC_CONTEXT_KEY);
}

function destinationOf(ctx: any, system: string | undefined): string | undefined {
  const raw = system === 'kafka' ? ctx?.getTopic?.() : ctx?.getPattern?.();
  if (raw === undefined || raw === null || raw === '') return undefined;
  return patternToString(raw);
}

export interface HandlerCall {
  system: string;
  destination: string;
  /** The payload to capture; `undefined` when there is none. */
  payload?: { value: unknown };
}

/**
 * Records captured payload (per `microservices.captureData`) on the handler span and the handler
 * metrics. Shared by pattern handlers and SQS handlers. Never throws.
 */
export function settleHandler(call: HandlerCall, span: Span, error: unknown | undefined, seconds: number): void {
  const failed = safely(
    'classify handler error',
    () => error !== undefined && classifyError(error, getClassifyDefaults()).isError,
    error !== undefined,
  );
  safely(
    'capture handler data',
    () => {
      if (!call.payload) return;
      const { captureData, maxDataBytes } = getMicroservicesSettings();
      if (!(captureData === 'always' || (captureData === 'error' && failed))) return;
      const { body, truncated } = serializeBody(getDefaultRedactor().redact(call.payload.value), maxDataBytes);
      span.setAttribute('nestjs.microservice.data', body);
      if (truncated) span.setAttribute('nestjs.microservice.data.truncated', true);
    },
    undefined,
  );
  safely(
    'handler metrics',
    () => {
      const m = instruments();
      const base: Attributes = {
        'messaging.system': call.system,
        'messaging.destination.name': call.destination,
        'messaging.operation.name': 'process',
      };
      if (!failed) {
        m.duration.record(seconds, base);
        return;
      }
      const attrs = { ...base, 'error.type': errorType(error) };
      m.duration.record(seconds, attrs);
      m.errors.add(1, attrs);
    },
    undefined,
  );
}

/**
 * Span kind and per-call description for a `@MessagePattern`/`@EventPattern` handler, or undefined
 * for methods without pattern metadata.
 */
export function describeHandler(owner: object, name: string): Pick<WrapOptions, 'kind' | 'describe'> | undefined {
  return safely(
    'describe handler',
    () => {
      const fn = Object.getOwnPropertyDescriptor(owner, name)?.value;
      if (typeof fn !== 'function') return undefined;
      const patterns: unknown = Reflect.getMetadata(PATTERN_METADATA, fn);
      if (!Array.isArray(patterns) || patterns.length === 0) return undefined;
      const isEvent = Reflect.getMetadata(PATTERN_HANDLER_METADATA, fn) === EVENT_HANDLER;
      const pattern = patternToString(patterns[0]);
      const kind = isEvent ? 'event' : 'message';

      const describe = (args: unknown[]): CallDescription => {
        const ctx = safely('find rpc context', () => findContext(args), undefined);
        const contextSystem = systemOfContext(ctx);
        const call: HandlerCall = {
          system: contextSystem ?? 'nestjs',
          destination: safely('handler destination', () => destinationOf(ctx, contextSystem), undefined) ?? pattern,
          // The payload is the first argument, unless the handler only takes the context.
          payload: args.length > 0 && args[0] !== ctx ? { value: args[0] } : undefined,
        };
        return {
          attributes: {
            'messaging.system': call.system,
            'messaging.destination.name': call.destination,
            'messaging.operation.type': 'process',
            'nestjs.microservice.kind': kind,
            'nestjs.microservice.pattern': pattern,
          },
          onSettled: (span, error, seconds) => settleHandler(call, span, error, seconds),
        };
      };
      return { kind: isEvent ? SpanKind.CONSUMER : SpanKind.SERVER, describe };
    },
    undefined,
  );
}
