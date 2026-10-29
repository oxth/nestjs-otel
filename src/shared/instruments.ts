import { type Meter, type MeterProvider, metrics } from '@opentelemetry/api';
import { SCOPE_NAME } from './constants';

/**
 * Returns a getter for instruments built once per global MeterProvider: keyed on the provider's
 * identity, so a provider registered later (or after `metrics.disable()`) gets fresh instruments
 * while the hot path reuses them.
 */
export function instrumentsPerMeterProvider<T>(create: (meter: Meter) => T): () => T {
  const cache = new WeakMap<MeterProvider, T>();
  return () => {
    const provider = metrics.getMeterProvider();
    let m = cache.get(provider);
    if (m === undefined) {
      m = create(provider.getMeter(SCOPE_NAME));
      cache.set(provider, m);
    }
    return m;
  };
}
