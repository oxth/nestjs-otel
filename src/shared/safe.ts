import { diag } from '@opentelemetry/api';

export function safely<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    try {
      diag.warn(`@oxth/nestjs-otel: ${label} failed`, err);
    } catch {
      // never throw into app code
    }
    return fallback;
  }
}
