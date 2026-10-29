import { type Context, context, defaultTextMapSetter, propagation } from '@opentelemetry/api';
import { safely } from '../shared/safe';

/** Writes the W3C trace context of `ctx` (default: active) into `carrier`. Never throws. */
export function injectContext(
  carrier: Record<string, unknown>,
  ctx: Context = context.active(),
): Record<string, unknown> {
  return safely(
    'injectContext',
    () => {
      if (carrier === null || typeof carrier !== 'object') return carrier;
      propagation.inject(ctx, carrier, defaultTextMapSetter);
      return carrier;
    },
    carrier,
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
