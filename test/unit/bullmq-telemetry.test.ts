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
    expect(v).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(v).toContain('[REDACTED]');
  });

  it('failed reason on an event is redacted', () => {
    const input = 'bad password=hunter2 token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
    const span = t().tracer.startSpan('process emails', { kind: 4 });
    span.addEvent('job failed', { 'bullmq.job.failed.reason': input });
    span.end();
    const v = tracing.spans()[0].events[0].attributes?.['bullmq.job.failed.reason'];
    expect(v).toBe(getDefaultRedactor().redactString(input));
    expect(v).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(v).toContain('[REDACTED]');
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

  it('process without propagated context is a root even under an active span', () => {
    const tr = trace.getTracer('x');
    tr.startActiveSpan('boot', (boot) => {
      t().tracer.startSpan('process emails', { kind: 4 }).end();
      boot.end();
    });
    const proc = tracing.spans().find((s) => s.name === 'process emails')!;
    expect(proc.parentSpanContext).toBeUndefined();
  });

  it('process starts unsuppressed', () => {
    const span = t().tracer.startSpan('process emails', { kind: 4 }, suppressTracing(context.active()));
    span.end();
    const [s] = tracing.spans();
    expect(s.name).toBe('process emails');
    expect(s.kind).toBe(SpanKind.CONSUMER);
  });

  it('process setSpanOnContext(undefined) runs under the process span (BullMQ 5.24, no metadata)', () => {
    const span = t().tracer.startSpan('process emails', { kind: 4 });
    const ctx = span.setSpanOnContext(undefined);
    const active = t().contextManager.with(ctx, () => trace.getSpan(context.active()));
    t().contextManager.with(ctx, () => trace.getTracer('x').startSpan('EmailsProcessor.process').end());
    span.end();
    const proc = tracing.spans().find((s) => s.name === 'process emails')!;
    const child = tracing.spans().find((s) => s.name === 'EmailsProcessor.process')!;
    expect(active?.spanContext().spanId).toBe(proc.spanContext().spanId);
    expect(child.parentSpanContext?.spanId).toBe(proc.spanContext().spanId);
  });

  it('process context is unsuppressed even when the parent context is suppressed (v6 resume)', () => {
    const tr = trace.getTracer('test');
    let md = '';
    tr.startActiveSpan('caller', (s) => {
      md = t().contextManager.getMetadata(context.active());
      s.end();
    });
    tracing.reset();
    // v6 `Worker.resume()` restarts the main loop inside the non-recorded `resume` operation.
    const resume = t().tracer.startSpan('resume emails', { kind: 0 });
    context.with(resume.setSpanOnContext(context.active()), () => {
      const parent = t().contextManager.fromMetadata(t().contextManager.active(), md);
      const span = t().tracer.startSpan('process emails', { kind: 4 }, parent);
      t().contextManager.with(span.setSpanOnContext(parent), () =>
        trace.getTracer('x').startSpan('EmailsProcessor.process').end(),
      );
      span.end();
    });
    resume.end();
    const proc = tracing.spans().find((s) => s.name === 'process emails')!;
    const child = tracing.spans().find((s) => s.name === 'EmailsProcessor.process');
    expect(child).toBeDefined();
    expect(child!.parentSpanContext?.spanId).toBe(proc.spanContext().spanId);
    expect(tracing.spans().map((s) => s.name).sort()).toEqual(['EmailsProcessor.process', 'process emails']);
  });

  it('a suppressed input context on a process span still records nested spans', () => {
    const span = t().tracer.startSpan('process emails', { kind: 4 });
    t().contextManager.with(span.setSpanOnContext(suppressTracing(ROOT_CONTEXT)), () =>
      trace.getTracer('x').startSpan('nested').end(),
    );
    span.end();
    const proc = tracing.spans().find((s) => s.name === 'process emails')!;
    const nested = tracing.spans().find((s) => s.name === 'nested');
    expect(nested?.parentSpanContext?.spanId).toBe(proc.spanContext().spanId);
  });

  it('non-process operations still suppress, also with an undefined context', () => {
    const add = t().tracer.startSpan('add emails', { kind: 3 });
    t().contextManager.with(add.setSpanOnContext(suppressTracing(ROOT_CONTEXT)), () =>
      trace.getTracer('x').startSpan('under-suppressed-add').end(),
    );
    add.end();
    const pause = t().tracer.startSpan('pause emails', { kind: 0 });
    t().contextManager.with(pause.setSpanOnContext(undefined), () => trace.getTracer('x').startSpan('nested').end());
    pause.end();
    expect(tracing.spans().map((s) => s.name)).toEqual(['add emails']);
  });

  it('addNode keeps BullMQ\'s span name and takes the destination from it (5.24 passes the job name)', () => {
    const span = t().tracer.startSpan('addNode children', { kind: 3 });
    span.setAttributes({ 'bullmq.queue.name': 'child-job', 'bullmq.queue.operation': 'addNode' });
    span.end();
    const [s] = tracing.spans();
    expect(s.name).toBe('addNode children');
    expect(s.attributes['messaging.destination.name']).toBe('children');
    expect(s.attributes['messaging.operation.name']).toBe('addNode');
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

  it('getMetadata is empty when nothing propagates (suppressed or no span)', () => {
    trace.getTracer('test').startActiveSpan('S', (s) => {
      expect(t().contextManager.getMetadata(suppressTracing(context.active()))).toBe('');
      const op = t().tracer.startSpan('moveToDelayed emails', { kind: 0 });
      expect(t().contextManager.getMetadata(op.setSpanOnContext(context.active()))).toBe('');
      s.end();
    });
    expect(t().contextManager.getMetadata(ROOT_CONTEXT)).toBe('');
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
    expect(sa.status.message).toBe('boom');
    expect(sa.events.some((e) => e.name === 'exception')).toBe(true);
    expect(sb.status.code).toBe(SpanStatusCode.ERROR);
    expect(sb.status.message).toBe('redis down');
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
