import {
  type Context,
  isSpanContextValid,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  TraceFlags,
  trace,
} from '@opentelemetry/api';

/** The only field of {@link XTracePropagator}: deliberately not a W3C name. */
export const X_TRACE = 'x-trace';

/**
 * A minimal non-W3C propagator (`x-trace: <traceId>-<spanId>`), standing in for B3 or Jaeger to
 * prove the library follows the global propagator's fields instead of hard-coding `traceparent`.
 */
export class XTracePropagator implements TextMapPropagator {
  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const sc = trace.getSpanContext(ctx);
    if (!sc || !isSpanContextValid(sc)) return;
    setter.set(carrier, X_TRACE, `${sc.traceId}-${sc.spanId}`);
  }

  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const raw = getter.get(carrier, X_TRACE);
    const value = Array.isArray(raw) ? raw[0] : raw;
    const m = typeof value === 'string' ? /^([0-9a-f]{32})-([0-9a-f]{16})$/.exec(value) : null;
    if (!m) return ctx;
    return trace.setSpanContext(ctx, { traceId: m[1]!, spanId: m[2]!, traceFlags: TraceFlags.SAMPLED, isRemote: true });
  }

  fields(): string[] {
    return [X_TRACE];
  }
}
