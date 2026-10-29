import { type Link, SpanKind, trace } from '@opentelemetry/api';
import { extractContext } from '../propagation/helpers';
import { safely } from '../shared/safe';
import type { CallDescription, WrapOptions } from '../tracing/wrap';
import { type HandlerCall, settleHandler } from './handler';

/** `SQS_CONSUMER_METHOD` in `@ssut/nestjs-sqs`; set on the method by `@SqsMessageHandler`. */
const SQS_CONSUMER_METHOD = Symbol.for('SQS_CONSUMER_METHOD');

interface SqsMessage {
  MessageId?: string;
  Body?: unknown;
  MessageAttributes?: Record<string, { StringValue?: unknown } | undefined>;
}

function carrierOf(message: SqsMessage | undefined): Record<string, unknown> | undefined {
  const attrs = message?.MessageAttributes;
  if (!attrs || typeof attrs !== 'object') return undefined;
  const carrier: Record<string, unknown> = {};
  for (const key of ['traceparent', 'tracestate', 'baggage']) {
    const v = attrs[key]?.StringValue;
    if (typeof v === 'string') carrier[key] = v;
  }
  return carrier.traceparent === undefined ? undefined : carrier;
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * Span kind and per-call description for a `@ssut/nestjs-sqs` handler (`@SqsMessageHandler`), or
 * undefined for methods without that metadata. Single handlers continue the producer's trace from
 * the message attributes; batch handlers get one span link per message that carries context.
 */
export function describeSqsHandler(owner: object, name: string): Pick<WrapOptions, 'kind' | 'describe'> | undefined {
  return safely(
    'describe sqs handler',
    () => {
      const fn = Object.getOwnPropertyDescriptor(owner, name)?.value;
      if (typeof fn !== 'function') return undefined;
      const meta = Reflect.getMetadata(SQS_CONSUMER_METHOD, fn) as { name?: unknown; batch?: boolean } | undefined;
      if (!meta || typeof meta !== 'object') return undefined;
      const destination = String(meta.name ?? 'unknown');
      const batch = meta.batch === true;

      const describe = (args: unknown[]): CallDescription => {
        const call: HandlerCall = { system: 'aws_sqs', destination };
        const attributes: CallDescription['attributes'] = {
          'messaging.system': 'aws_sqs',
          'messaging.destination.name': destination,
          'messaging.operation.type': 'process',
        };
        const result: CallDescription = {
          attributes,
          onSettled: (span, error, seconds) => settleHandler(call, span, error, seconds),
        };
        if (batch) {
          const messages = (Array.isArray(args[0]) ? args[0] : []) as SqsMessage[];
          attributes['messaging.batch.message_count'] = messages.length;
          const links: Link[] = [];
          for (const m of messages) {
            const carrier = carrierOf(m);
            if (!carrier) continue;
            const sc = trace.getSpanContext(extractContext(carrier));
            if (sc && trace.isSpanContextValid(sc)) links.push({ context: sc });
          }
          if (links.length > 0) result.links = links;
          call.payload = { value: messages.map((m) => parseBody(m?.Body)) };
        } else {
          const message = args[0] as SqsMessage | undefined;
          if (message?.MessageId !== undefined) attributes['messaging.message.id'] = String(message.MessageId);
          const carrier = carrierOf(message);
          if (carrier) result.parent = extractContext(carrier);
          if (message && typeof message === 'object') call.payload = { value: parseBody(message.Body) };
        }
        return result;
      };
      return { kind: SpanKind.CONSUMER, describe };
    },
    undefined,
  );
}
