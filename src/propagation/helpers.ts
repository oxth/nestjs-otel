import { type Context, context, defaultTextMapSetter, propagation } from '@opentelemetry/api';
import { safely } from '../shared/safe';

/**
 * Writes the trace context of `ctx` (default: active) into `carrier` with the global propagator
 * (W3C unless `OTEL_PROPAGATORS` says otherwise) and returns `carrier`. Never throws.
 */
export function injectContext<T extends object>(
  carrier: T,
  ctx: Context = context.active(),
): T & Record<string, unknown> {
  // The propagator may add any key, so the result is also indexable by string.
  const out = carrier as T & Record<string, unknown>;
  return safely(
    'injectContext',
    () => {
      if (out === null || typeof out !== 'object') return out;
      propagation.inject(ctx, out, defaultTextMapSetter);
      return out;
    },
    out,
  );
}

/** Reads a trace context from `carrier`. Returns `base` (default: active) on invalid input. */
export function extractContext(carrier: Record<string, unknown> | undefined, base?: Context): Context {
  const fallback = base ?? context.active();
  return safely(
    'extractContext',
    () => {
      if (carrier === null || typeof carrier !== 'object') return fallback;
      return propagation.extract(fallback, carrier);
    },
    fallback,
  );
}

/** Runs `fn` with `ctx` active. Errors from `fn` propagate unchanged. */
export function withContext<T>(ctx: Context, fn: () => T): T {
  return context.with(ctx, fn);
}
