import { context, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractContext, injectContext, withContext } from '../../src/propagation/helpers';
import { setupInMemoryTracing } from '../integration/helpers/tracing';

const tracing = setupInMemoryTracing();

beforeAll(() => propagation.setGlobalPropagator(new W3CTraceContextPropagator()));
afterAll(async () => {
  propagation.disable();
  await tracing.shutdown();
});

describe('propagation helpers', () => {
  it('inject then extract round-trips the active span', () => {
    const tracer = trace.getTracer('t');
    tracer.startActiveSpan('S', (span) => {
      const ctx = extractContext(injectContext({}));
      const sc = trace.getSpanContext(ctx);
      expect(sc?.traceId).toBe(span.spanContext().traceId);
      expect(sc?.spanId).toBe(span.spanContext().spanId);
      span.end();
    });
  });

  it('injectContext keeps existing keys and returns the same object', () => {
    const carrier = { keep: 'me' };
    trace.getTracer('t').startActiveSpan('S', (span) => {
      expect(injectContext(carrier)).toBe(carrier);
      span.end();
    });
    expect(carrier.keep).toBe('me');
    expect((carrier as Record<string, unknown>).traceparent).toMatch(/^00-/);
  });

  it('extractContext falls back on invalid input', () => {
    expect(extractContext(undefined)).toBe(context.active());
    expect(extractContext({ traceparent: 42 })).toBe(context.active());
    const base = context.active().setValue(Symbol('x'), 1);
    expect(extractContext(undefined, base)).toBe(base);
    expect(extractContext({ traceparent: 42 }, base)).toBe(base);
  });

  it('withContext runs fn in ctx, returns its value and propagates errors', () => {
    const key = Symbol('k');
    const ctx = context.active().setValue(key, 'v');
    expect(withContext(ctx, () => context.active().getValue(key))).toBe('v');
    expect(() =>
      withContext(ctx, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });

  it('never throws when the propagator throws', () => {
    const boom = () => {
      throw new Error('x');
    };
    propagation.setGlobalPropagator({ inject: boom, extract: boom, fields: () => [] });
    try {
      const carrier = { a: 'b' };
      expect(injectContext(carrier)).toBe(carrier);
      const base = context.active();
      expect(extractContext({ traceparent: 'x' }, base)).toBe(base);
    } finally {
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    }
  });
});
