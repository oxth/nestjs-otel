import { isSpanContextValid, trace } from '@opentelemetry/api';
import { safely } from './shared/safe';

/**
 * Manual fallback for adding trace context to pino logs, for setups where the pino
 * instrumentation can't patch pino: `pino({ mixin: otelPinoMixin() })`. Returns
 * `{ trace_id, span_id, trace_flags }` for the active span, `{}` when there is none.
 */
export function otelPinoMixin(): () => Record<string, string> {
  return () =>
    safely(
      'pino mixin',
      (): Record<string, string> => {
        const ctx = trace.getActiveSpan()?.spanContext();
        if (!ctx || !isSpanContextValid(ctx)) return {};
        return {
          trace_id: ctx.traceId,
          span_id: ctx.spanId,
          trace_flags: `0${ctx.traceFlags.toString(16)}`.slice(-2),
        };
      },
      {},
    );
}
