import { unsuppressTracing, suppressTracing } from '@opentelemetry/core';
import {
  type Attributes,
  type AttributeValue,
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { getDefaultRedactor } from '../redact/redactor';
import { recordError } from '../errors/record';
import { PACKAGE_VERSION, SCOPE_NAME } from '../shared/constants';
import { getGlobalState } from '../shared/global-state';
import { safely } from '../shared/safe';
import { getClassifyDefaults } from '../tracing/decorators';

/** Structural mirror of BullMQ's `Span` (kept local so published declarations do not depend on `bullmq`). */
export interface BullmqSpan {
  /** BullMQ 5.24 passes `undefined` for a consumer span whose job carries no propagated context. */
  setSpanOnContext(ctx: Context | undefined): Context;
  setAttribute(key: string, value: unknown): BullmqSpan;
  setAttributes(attributes: Record<string, unknown>): BullmqSpan;
  addEvent(name: string, attributes?: Record<string, unknown>): BullmqSpan;
  recordException(exception: string | { name?: string; message?: string; stack?: string; code?: unknown }, time?: unknown): void;
  end(): void;
}

/** Structural mirror of BullMQ's `Telemetry` (no `meter`). */
export interface BullmqTelemetry {
  tracer: { startSpan(name: string, options?: { kind?: number }, ctx?: Context): BullmqSpan };
  contextManager: {
    with<R>(ctx: Context, fn: () => R): R;
    active(): Context;
    root(): Context;
    getMetadata(ctx: Context): string;
    fromMetadata(activeCtx: Context, metadata: string): Context;
  };
}

export const RECORDED_OPERATIONS: ReadonlyMap<string, 'send' | 'process'> = new Map([
  ['add', 'send'],
  ['addBulk', 'send'],
  ['addFlow', 'send'],
  ['addBulkFlows', 'send'],
  ['addNode', 'send'],
  ['process', 'process'],
]);

const ALLOWED = new Set([
  'bullmq.queue.name',
  'bullmq.queue.operation',
  'bullmq.job.name',
  'bullmq.job.id',
  'bullmq.job.bulk.count',
  'bullmq.job.bulk.names',
  'bullmq.job.attempts.made',
  'bullmq.worker.id',
  'bullmq.worker.name',
  'bullmq.flow.name',
  'bullmq.job.scheduler.id',
  'bullmq.job.type',
  'bullmq.job.state',
  'bullmq.job.processed.timestamp',
  'bullmq.job.attempt_finished_timestamp',
  'bullmq.job.failed.reason',
]);

function toAttributeValue(v: unknown): AttributeValue | undefined {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => String(x));
  return v === undefined || v === null ? undefined : String(v);
}

function filterAttributes(input: Record<string, unknown> | undefined): Attributes {
  const out: Attributes = {};
  if (!input) return out;
  for (const [key, raw] of Object.entries(input)) {
    if (!ALLOWED.has(key)) continue;
    const value = toAttributeValue(raw);
    if (value === undefined) continue;
    out[key] = key === 'bullmq.job.failed.reason' ? getDefaultRedactor().redactString(String(value)) : value;
  }
  return out;
}

const noopSpan: BullmqSpan = {
  setSpanOnContext: (ctx) =>
    safely('bullmq suppress', () => suppressTracing(ctx ?? context.active()), ctx ?? ROOT_CONTEXT),
  setAttribute: () => noopSpan,
  setAttributes: () => noopSpan,
  addEvent: () => noopSpan,
  recordException: () => {},
  end: () => {},
};

class RecordingSpan implements BullmqSpan {
  constructor(
    private readonly span: Span,
    private readonly operation: string,
    private readonly type: 'send' | 'process',
  ) {}

  /**
   * The context BullMQ runs the operation's callback in (for `process`, the processor).
   * - BullMQ 5.24 passes `undefined` for a `process` span without propagated context; the active context is used
   *   instead, so the processor still runs under the `process` span.
   * - For `process`, the base is unsuppressed: v6 `Worker.resume()` restarts the main loop inside the
   *   (suppressed, non-recorded) `resume` operation, and the propagated parent context is built from it.
   */
  setSpanOnContext(ctx: Context | undefined): Context {
    return safely(
      'bullmq setSpanOnContext',
      () => {
        const base = ctx ?? context.active();
        return trace.setSpan(this.type === 'process' ? unsuppressTracing(base) : base, this.span);
      },
      ctx ?? ROOT_CONTEXT,
    );
  }

  setAttribute(key: string, value: unknown): BullmqSpan {
    return this.setAttributes({ [key]: value });
  }

  setAttributes(attributes: Record<string, unknown>): BullmqSpan {
    safely(
      'bullmq setAttributes',
      () => {
        const attrs = filterAttributes(attributes);
        for (const [key, value] of Object.entries(attrs)) {
          this.span.setAttribute(key, value as AttributeValue);
          switch (key) {
            case 'bullmq.queue.name':
              // BullMQ 5.24 `FlowProducer.addNode` passes the job name here; its span name already has the queue.
              if (value !== '' && this.operation !== 'addNode') {
                this.span.updateName(`${this.operation} ${String(value)}`);
                this.span.setAttribute('messaging.destination.name', value);
              }
              break;
            case 'bullmq.queue.operation':
              this.span.setAttribute('messaging.operation.name', this.operation);
              break;
            case 'bullmq.job.id':
              this.span.setAttribute('messaging.message.id', String(value));
              break;
            case 'bullmq.job.bulk.count':
              this.span.setAttribute('messaging.batch.message_count', Number(value));
              break;
          }
        }
      },
      undefined,
    );
    return this;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): BullmqSpan {
    safely('bullmq addEvent', () => this.span.addEvent(name, filterAttributes(attributes)), undefined);
    return this;
  }

  recordException(exception: Parameters<BullmqSpan['recordException']>[0]): void {
    safely(
      'bullmq recordException',
      () => {
        if (typeof exception === 'string') {
          this.span.setStatus({ code: SpanStatusCode.ERROR, message: getDefaultRedactor().redactString(exception) });
          return;
        }
        // recordError sets ERROR with the redacted message; for non-errors it leaves the status alone.
        recordError(this.span, exception, getClassifyDefaults());
      },
      undefined,
    );
  }

  end(): void {
    safely('bullmq end', () => this.span.end(), undefined);
  }

  /** Initial attributes, set once the span is created. */
  init(): void {
    safely(
      'bullmq init',
      () => {
        this.span.setAttributes({
          'messaging.system': 'bullmq',
          'messaging.operation.name': this.operation,
          'messaging.operation.type': this.type,
        });
      },
      undefined,
    );
  }
}

function createTelemetry(): BullmqTelemetry {
  return {
    tracer: {
      startSpan(name, options, ctx) {
        return safely<BullmqSpan>(
          'bullmq startSpan',
          () => {
            const operation = name.split(' ')[0] ?? name;
            const type = RECORDED_OPERATIONS.get(operation);
            if (!type) return noopSpan;
            // A `process` span without propagated context is a trace root: BullMQ's main worker loop is
            // not detached, so the active context may be whatever span the worker was created under.
            let parent = ctx ?? (type === 'process' ? ROOT_CONTEXT : context.active());
            if (type === 'process') parent = unsuppressTracing(parent);
            const span = trace
              .getTracer(SCOPE_NAME, PACKAGE_VERSION)
              .startSpan(name, { kind: options?.kind }, parent);
            const wrapped = new RecordingSpan(span, operation, type);
            wrapped.init();
            // BullMQ names `addNode` spans `addNode <queueName>` on every supported version.
            if (operation === 'addNode' && name.length > operation.length + 1) {
              safely(
                'bullmq addNode destination',
                () => span.setAttribute('messaging.destination.name', name.slice(operation.length + 1)),
                undefined,
              );
            }
            return wrapped;
          },
          noopSpan,
        );
      },
    },
    contextManager: {
      with: (ctx, fn) => context.with(ctx, fn),
      active: () => context.active(),
      root: () => ROOT_CONTEXT,
      getMetadata: (ctx) =>
        safely(
          'bullmq getMetadata',
          () => {
            const carrier: Record<string, string> = {};
            propagation.inject(ctx, carrier);
            return JSON.stringify(carrier);
          },
          '{}',
        ),
      fromMetadata: (activeCtx, metadata) =>
        safely('bullmq fromMetadata', () => propagation.extract(activeCtx, JSON.parse(metadata) as object), activeCtx),
    },
  };
}

export function getBullmqTelemetry(): BullmqTelemetry {
  const state = getGlobalState();
  state.bullmqTelemetry ??= createTelemetry();
  return state.bullmqTelemetry as BullmqTelemetry;
}

export function isOwnBullmqTelemetry(t: unknown): boolean {
  return t !== null && t !== undefined && t === getGlobalState().bullmqTelemetry;
}
