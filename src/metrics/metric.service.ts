import { Injectable } from '@nestjs/common';
import {
  type Counter,
  type Gauge,
  type Histogram,
  type Meter,
  type MetricOptions,
  metrics,
  type UpDownCounter,
} from '@opentelemetry/api';
import { SCOPE_NAME } from '../shared/constants';

/** Creates custom metric instruments on the `@oxth/nestjs-otel` meter, cached by name. */
@Injectable()
export class MetricService {
  private readonly cache = new Map<string, unknown>();

  private meter(): Meter {
    return metrics.getMeter(SCOPE_NAME);
  }

  private get<T>(kind: string, name: string, create: () => T): T {
    const key = `${kind}:${name}`;
    let instrument = this.cache.get(key) as T | undefined;
    if (instrument === undefined) {
      instrument = create();
      this.cache.set(key, instrument);
    }
    return instrument;
  }

  counter(name: string, o?: MetricOptions): Counter {
    return this.get('counter', name, () => this.meter().createCounter(name, o));
  }

  histogram(name: string, o?: MetricOptions): Histogram {
    return this.get('histogram', name, () => this.meter().createHistogram(name, o));
  }

  upDownCounter(name: string, o?: MetricOptions): UpDownCounter {
    return this.get('upDownCounter', name, () => this.meter().createUpDownCounter(name, o));
  }

  gauge(name: string, o?: MetricOptions): Gauge {
    return this.get('gauge', name, () => this.meter().createGauge(name, o));
  }
}
