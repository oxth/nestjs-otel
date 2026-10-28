import { Controller, Get, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Counter, Histogram, MetricService, OtelModule, Span } from '../../src/index';
import { WRAPPED } from '../../src/shared/symbols';
import { setupInMemoryTracing } from './helpers/tracing';

const t = setupInMemoryTracing();
const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
const provider = new MeterProvider({ readers: [reader] });

beforeAll(() => {
  metrics.disable();
  metrics.setGlobalMeterProvider(provider);
});
afterAll(async () => {
  await provider.shutdown();
  metrics.disable();
});
beforeEach(() => exporter.reset());

async function collect(name: string) {
  await reader.forceFlush();
  const found = exporter
    .getMetrics()
    .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
    .filter((m) => m.descriptor.name === name);
  return found.at(-1);
}

class Boom extends Error {}

class Work {
  @Counter('work.calls', { attributes: { kind: 'x' } })
  run(fail = false): number {
    if (fail) throw new Error('nope');
    return 1;
  }

  @Histogram('work.duration')
  async slow(fail = false): Promise<string> {
    await new Promise((r) => setTimeout(r, 5));
    if (fail) throw new Boom('bad');
    return 'ok';
  }
}

describe('MetricService', () => {
  it('caches instruments by name', () => {
    const s = new MetricService();
    expect(s.counter('a')).toBe(s.counter('a'));
    expect(s.counter('a')).not.toBe(s.counter('b'));
    expect(s.histogram('h')).toBe(s.histogram('h'));
    expect(s.upDownCounter('u')).toBe(s.upDownCounter('u'));
    expect(s.gauge('g')).toBe(s.gauge('g'));
  });

  it('records through the global meter provider', async () => {
    new MetricService().counter('svc.count').add(3);
    const m = await collect('svc.count');
    expect((m?.dataPoints[0] as { value: number }).value).toBe(3);
  });
});

describe('@Counter', () => {
  it('counts calls including failures', async () => {
    const w = new Work();
    w.run();
    expect(() => w.run(true)).toThrow('nope');
    const m = await collect('work.calls');
    expect(m?.dataPoints).toHaveLength(1);
    expect((m?.dataPoints[0] as { value: number }).value).toBe(2);
    expect(m?.dataPoints[0].attributes).toEqual({ kind: 'x' });
  });
});

describe('@Histogram', () => {
  it('records seconds with error.type on rejection', async () => {
    const w = new Work();
    await expect(w.slow()).resolves.toBe('ok');
    await expect(w.slow(true)).rejects.toBeInstanceOf(Boom);
    const m = await collect('work.duration');
    expect(m?.descriptor.unit).toBe('s');
    const points = m?.dataPoints as { attributes: Record<string, unknown>; value: { count: number; sum: number } }[];
    const ok = points.find((p) => p.attributes['error.type'] === undefined);
    const err = points.find((p) => p.attributes['error.type'] === 'Boom');
    expect(ok?.value.count).toBe(1);
    expect(err?.value.count).toBe(1);
    expect(ok?.value.sum).toBeGreaterThan(0.004);
    expect(ok?.value.sum).toBeLessThan(2);
  });
});

describe('decorator integration', () => {
  it('metric decorators keep route metadata when stacked above @Get', async () => {
    @Controller()
    class MetricController {
      @Counter('route.calls')
      @Get('m')
      m(): string {
        return 'ok';
      }
    }
    const ref = await Test.createTestingModule({ controllers: [MetricController] }).compile();
    const app = ref.createNestApplication({ logger: false });
    await app.init();
    await request(app.getHttpServer()).get('/m').expect(200).expect('ok');
    expect(((await collect('route.calls'))?.dataPoints[0] as { value: number }).value).toBe(1);
    await app.close();
  });

  it('does not set the WRAPPED flag on a metric-only method, and propagates it over @Span', () => {
    class A {
      @Counter('flag.a')
      a() {}
      @Counter('flag.b')
      @Span()
      b() {}
    }
    expect((A.prototype.a as any)[WRAPPED]).toBeUndefined();
    expect((A.prototype.b as any)[WRAPPED]).toBe(true);
  });

  it('@Span and @Counter on the same method both apply', async () => {
    class Both {
      @Counter('both.calls')
      @Span('both.span')
      go(): number {
        return 1;
      }
    }
    new Both().go();
    expect(t.spans().map((s) => s.name)).toEqual(['both.span']);
    expect(((await collect('both.calls'))?.dataPoints[0] as { value: number }).value).toBe(1);
  });

  it('auto-instrumentation still wraps a @Counter method exactly once', async () => {
    @Injectable()
    class Counted {
      @Counter('auto.calls')
      work(): number {
        return 1;
      }
      @Counter('auto.both')
      @Span()
      spanned(): number {
        return 2;
      }
    }
    const ref = await Test.createTestingModule({ imports: [OtelModule.forRoot()], providers: [Counted] }).compile();
    const app = ref.createNestApplication({ logger: false });
    await app.init();
    t.reset();
    const svc = app.get(Counted);
    svc.work();
    svc.spanned();
    const names = t.spans().map((s) => s.name);
    expect(names.filter((n) => n === 'Counted.work')).toHaveLength(1);
    expect(names.filter((n) => n === 'Counted.spanned')).toHaveLength(1);
    expect(((await collect('auto.calls'))?.dataPoints[0] as { value: number }).value).toBe(1);
    await app.close();
  });
});
