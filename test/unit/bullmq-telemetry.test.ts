import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { suppressTracing, W3CTraceContextPropagator } from '@opentelemetry/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getBullmqTelemetry, isOwnBullmqTelemetry } from '../../src/queue/bullmq-telemetry';
import { getDefaultRedactor } from '../../src/redact/redactor';
import { setupInMemoryTracing } from '../integration/helpers/tracing';

const tracing = setupInMemoryTracing();
beforeAll(() => propagation.setGlobalPropagator(new W3CTraceContextPropagator()));

const t = () => getBullmqTelemetry();

describe('bullmq telemetry adapter', () => {
  it('names a producer span by operation and queue', () => {
    const span = t().tracer.startSpan('add emails.send', { kind: 3 });
    span.setAttributes({
      'bullmq.queue.name': 'emails',
      'bullmq.queue.operation': 'add',
      'bullmq.job.name': 'send',
      'bullmq.job.id': '7',
    });
    span.end();
    const [s] = tracing.spans();
    expect(tracing.spans()).toHaveLength(1);
    expect(s.name).toBe('add emails');
    expect(s.kind).toBe(SpanKind.PRODUCER);
    expect(s.instrumentationScope.name).toBe('@oxth/nestjs-otel');
    expect(s.attributes).toMatchObject({
      'messaging.system': 'bullmq',
      'messaging.operation.name': 'add',
      'messaging.operation.type': 'send',
      'messaging.destination.name': 'emails',
      'messaging.message.id': '7',
      'bullmq.job.name': 'send',
    });
  });

  it('operation without queue keeps the bare name', () => {
    const span = t().tracer.startSpan('addBulkFlows', { kind: 3 });
    span.setAttributes({ 'bullmq.queue.name': '', 'bullmq.queue.operation': 'addBulkFlows' });
    span.end();
    expect(tracing.spans()[0].name).toBe('addBulkFlows');
  });

  it('bulk count maps to batch size', () => {
    const span = t().tracer.startSpan('addBulk emails', { kind: 3 });
    span.setAttributes({ 'bullmq.queue.name': 'emails', 'bullmq.job.bulk.count': 3 });
    span.end();
    expect(tracing.spans()[0].attributes['messaging.batch.message_count']).toBe(3);
  });

  it('drops attributes outside the allowlist', () => {
    const span = t().tracer.startSpan('process emails', { kind: 4 });
    span.setAttributes({
      'bullmq.queue.name': 'emails',
      'bullmq.job.result': '{"a":1}',
      'bullmq.job.options': '{}',
      'bullmq.queue.options': '{}',
      'bullmq.job.progress': 5,
      'bullmq.job.deduplication.key': 'k',
    });
    span.addEvent('job completed', { 'bullmq.job.result': '{"token":"x"}' });
    span.end();
    const [s] = tracing.spans();
    for (const k of ['result', 'options', 'progress', 'deduplication.key']) {
      expect(s.attributes[`bullmq.job.${k}`]).toBeUndefined();
    }
    expect(s.attributes['bullmq.queue.options']).toBeUndefined();
    expect(s.events).toHaveLength(1);
    expect(s.events[0].name).toBe('job completed');
    expect(Object.keys(s.events[0].attributes ?? {})).toHaveLength(0);
  });

  it('failed reason is redacted', () => {
    const input = 'bad password=hunter2 token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
    const span = t().tracer.startSpan('process emails', { kind: 4 });
    span.setAttributes({ 'bullmq.job.failed.reason': input });
    span.end();
    const v = tracing.spans()[0].attributes['bullmq.job.failed.reason'];
    expect(v).toBe(getDefaultRedactor().redactString(input));
  });

  it.each(['getNextJob', 'extendLocks', 'moveStalledJobsToWait', 'complete', 'close', 'retryJobs'])(
    'internal operation %s records nothing and suppresses nested spans',
    (op) => {
      const span = t().tracer.startSpan(op, { kind: 0 });
      span.setAttributes({ 'bullmq.queue.name': 'emails' });
      t().contextManager.with(span.setSpanOnContext(context.active()), () =>
        trace.getTracer('x').startSpan('nested').end(),
      );
      span.end();
      expect(tracing.spans()).toHaveLength(0);
    },
  );

  it('process starts unsuppressed', () => {
    const span = t().tracer.startSpan('process emails', { kind: 4 }, suppressTracing(context.active()));
    span.end();
    const [s] = tracing.spans();
    expect(s.name).toBe('process emails');
    expect(s.kind).toBe(SpanKind.CONSUMER);
  });

  it('metadata round trip', () => {
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('S', (s) => {
      const md = t().contextManager.getMetadata(context.active());
      const parsed = JSON.parse(md);
      expect(parsed.traceparent).toContain(s.spanContext().traceId);
      const ctx = t().contextManager.fromMetadata(ROOT_CONTEXT, md);
      const sc = trace.getSpanContext(ctx);
      expect(sc?.traceId).toBe(s.spanContext().traceId);
      expect(sc?.spanId).toBe(s.spanContext().spanId);
      const base = context.active();
      expect(t().contextManager.fromMetadata(base, 'not json')).toBe(base);
      s.end();
    });
  });

  it('root() is ROOT_CONTEXT and singleton is stable', () => {
    expect(t().contextManager.root()).toBe(ROOT_CONTEXT);
    expect(getBullmqTelemetry()).toBe(getBullmqTelemetry());
    expect(isOwnBullmqTelemetry(getBullmqTelemetry())).toBe(true);
    expect(isOwnBullmqTelemetry({ tracer: {}, contextManager: {} })).toBe(false);
  });

  it('recordException marks the span failed', () => {
    const a = t().tracer.startSpan('process emails', { kind: 4 });
    a.recordException(new Error('boom'));
    a.end();
    const b = t().tracer.startSpan('process emails', { kind: 4 });
    b.recordException('redis down');
    b.end();
    const [sa, sb] = tracing.spans();
    expect(sa.status.code).toBe(SpanStatusCode.ERROR);
    expect(sa.events.some((e) => e.name === 'exception')).toBe(true);
    expect(sb.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('never throws', () => {
    const span = t().tracer.startSpan('add emails', { kind: 3 });
    const ctx = context.active();
    const spy = vi.spyOn(trace.getTracer('x').startSpan('y').constructor.prototype, 'setAttribute').mockImplementation(() => {
      throw new Error('x');
    });
    try {
      expect(() => span.setAttributes({ 'bullmq.queue.name': 'emails', 'bullmq.job.id': '1' })).not.toThrow();
      expect(() => span.addEvent('e')).not.toThrow();
      expect(() => span.end()).not.toThrow();
      expect(span.setSpanOnContext(ctx)).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
});
