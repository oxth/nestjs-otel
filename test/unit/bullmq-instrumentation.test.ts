import { context, metrics, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { patchBullmq, unpatchBullmq } from '../../src/queue/bullmq';
import { getBullmqTelemetry } from '../../src/queue/bullmq-telemetry';
import { resolveBullmqSettings, setBullmqSettings } from '../../src/queue/settings';
import { getGlobalState } from '../../src/shared/global-state';
import { setupInMemoryTracing } from '../integration/helpers/tracing';

const tracing = setupInMemoryTracing();
const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
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
beforeEach(async () => {
  await reader.forceFlush();
  exporter.reset();
});

async function points(name: string) {
  await reader.forceFlush();
  return exporter
    .getMetrics()
    .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
    .filter((m) => m.descriptor.name === name)
    .flatMap((m) => m.dataPoints as any[]);
}

function makeModule() {
  class QueueBase {
    opts: any;
    calls: any[][] = [];
    constructor(opts: any = {}) {
      this.opts = opts;
    }
    trace(...a: any[]) {
      this.calls.push(a);
      return { self: this, args: a };
    }
  }
  class Worker extends QueueBase {
    name = 'emails';
    impl: (job: any) => Promise<any> = async () => 'ok';
    originalCalls = 0;
    callProcessJob(job: any, _token?: string) {
      this.originalCalls++;
      return this.impl(job);
    }
  }
  class FlowProducer {}
  return { QueueBase, Worker, FlowProducer };
}

let mod: ReturnType<typeof makeModule>;
beforeEach(() => {
  mod = makeModule();
  patchBullmq(mod);
});
afterEach(() => {
  unpatchBullmq(mod);
  getGlobalState().bullmq = undefined;
});

const now = () => Date.now();
const jobOf = (over: any = {}) => ({
  name: 'send',
  attemptsMade: 0,
  opts: { attempts: 3 },
  timestamp: now() - 500,
  processedOn: now(),
  data: { password: 'p' },
  ...over,
});

async function runWorker(worker: any, job: any) {
  let result: any;
  let error: any;
  let thrown = false;
  await tracing_tracer_run(async () => {
    try {
      result = await worker.callProcessJob(job, 'tok');
    } catch (e) {
      thrown = true;
      error = e;
    }
  });
  return { result, error, thrown, span: tracing.spans().find((s) => s.name === 'p')! };
}

async function tracing_tracer_run(fn: () => Promise<void>) {
  const span = trace.getTracer('t').startSpan('p');
  await context.with(trace.setSpan(context.active(), span), fn);
  span.end();
}

describe('trace patch', () => {
  it('sets library telemetry only when none is set', () => {
    const q = new mod.QueueBase({});
    const out: any = q.trace('a', 'b');
    expect(q.opts.telemetry).toBe(getBullmqTelemetry());
    expect(q.calls).toEqual([['a', 'b']]);
    expect(out.self).toBe(q);
    const userT = { tracer: {}, contextManager: {} };
    const q2 = new mod.QueueBase({ telemetry: userT });
    q2.trace();
    expect(q2.opts.telemetry).toBe(userT);
  });
});

describe('FlowProducer telemetry accessor', () => {
  it('defaults to the adapter and can be overridden per instance', () => {
    'use strict';
    const fp: any = new mod.FlowProducer();
    expect(fp.telemetry).toBe(getBullmqTelemetry());
    const userT = {};
    expect(() => {
      fp.telemetry = userT;
    }).not.toThrow();
    expect(fp.telemetry).toBe(userT);
    expect((new mod.FlowProducer() as any).telemetry).toBe(getBullmqTelemetry());
  });
});

describe('callProcessJob success', () => {
  it('records attempt attributes and metrics, no data', async () => {
    const w = new mod.Worker();
    const { result, span } = await runWorker(w, jobOf());
    expect(result).toBe('ok');
    expect(w.originalCalls).toBe(1);
    expect(span.attributes).toMatchObject({
      'bullmq.job.attempt': 1,
      'bullmq.job.attempts.max': 3,
      'bullmq.job.outcome': 'completed',
    });
    expect(span.attributes['bullmq.job.data']).toBeUndefined();
    const done = await points('bullmq.jobs.completed');
    expect(done).toHaveLength(1);
    expect(done[0].value).toBe(1);
    expect(done[0].attributes['messaging.destination.name']).toBe('emails');
    expect(await points('messaging.process.duration')).toHaveLength(1);
    const wait = await points('bullmq.job.wait_time');
    expect(wait).toHaveLength(1);
    expect(wait[0].value.sum).toBeGreaterThan(0.3);
    expect(wait[0].value.sum).toBeLessThan(0.7);
  });

});

describe('callProcessJob failure', () => {
  it('rethrows the same error and records it', async () => {
    const w = new mod.Worker();
    const err = new Error('boom');
    w.impl = async () => {
      throw err;
    };
    const { error, span } = await runWorker(w, jobOf({ attemptsMade: 0, opts: { attempts: 2 } }));
    expect(error).toBe(err);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.filter((e) => e.name === 'exception')).toHaveLength(1);
    expect(span.attributes['bullmq.job.will_retry']).toBe(true);
    expect(span.attributes['bullmq.job.outcome']).toBe('failed');
    expect(String(span.attributes['bullmq.job.data'])).toContain('[REDACTED]');
    expect(String(span.attributes['bullmq.job.data'])).not.toContain('"p"');
    const failed = await points('bullmq.jobs.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].attributes['bullmq.job.will_retry']).toBe(true);
    const dur = await points('messaging.process.duration');
    expect(dur[0].attributes['error.type']).toBe('Error');
  });

  it('will_retry=false on last attempt and for UnrecoverableError', async () => {
    const w = new mod.Worker();
    w.impl = async () => {
      throw new Error('x');
    };
    let r = await runWorker(w, jobOf({ attemptsMade: 1, opts: { attempts: 2 } }));
    expect(r.span.attributes['bullmq.job.will_retry']).toBe(false);
    tracing.reset();
    const un = new Error('x');
    un.name = 'UnrecoverableError';
    w.impl = async () => {
      throw un;
    };
    r = await runWorker(w, jobOf());
    expect(r.span.attributes['bullmq.job.will_retry']).toBe(false);
  });
});

describe('control-flow errors', () => {
  const named = (name: string, message = 'm') => {
    const e = new Error(message);
    e.name = name;
    return e;
  };
  const cases: [Error, string][] = [
    [named('DelayedError'), 'delayed'],
    [named('WaitingError'), 'waiting'],
    [named('WaitingChildrenError'), 'waiting-children'],
    [named('RateLimitError'), 'rate-limited'],
    [new Error('bullmq:rateLimitExceeded'), 'rate-limited'],
  ];
  it.each(cases)('%s is not a failure', async (err, outcome) => {
    const w = new mod.Worker();
    w.impl = async () => {
      throw err;
    };
    const { error, span } = await runWorker(w, jobOf());
    expect(error).toBe(err);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span.events.filter((e) => e.name === 'exception')).toHaveLength(0);
    expect(span.attributes['bullmq.job.outcome']).toBe(outcome);
    expect(await points('bullmq.jobs.failed')).toHaveLength(0);
  });
});

describe('captureData', () => {
  it('always attaches on success', async () => {
    setBullmqSettings(resolveBullmqSettings({ captureData: 'always' }));
    const { span } = await runWorker(new mod.Worker(), jobOf());
    expect(span.attributes['bullmq.job.data']).toContain('[REDACTED]');
  });
  it('never attaches', async () => {
    setBullmqSettings(resolveBullmqSettings({ captureData: 'never' }));
    const w = new mod.Worker();
    w.impl = async () => {
      throw new Error('x');
    };
    const { span } = await runWorker(w, jobOf());
    expect(span.attributes['bullmq.job.data']).toBeUndefined();
  });
  it('truncates', async () => {
    setBullmqSettings(resolveBullmqSettings({ captureData: 'always', maxDataBytes: 16 }));
    const { span } = await runWorker(new mod.Worker(), jobOf({ data: { a: 'x'.repeat(100) } }));
    expect(span.attributes['bullmq.job.data.truncated']).toBe(true);
  });
});

describe('metrics', () => {
  it('wait time only on first attempt', async () => {
    await runWorker(new mod.Worker(), jobOf({ attemptsMade: 1 }));
    expect(await points('bullmq.job.wait_time')).toHaveLength(0);
  });

  it('skipped under app telemetry with a meter, spans still attributed', async () => {
    const w = new mod.Worker({ telemetry: { tracer: {}, contextManager: {}, meter: {} } });
    w.impl = async () => {
      throw new Error('x');
    };
    const { span } = await runWorker(w, jobOf());
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['bullmq.job.attempt']).toBe(1);
    for (const n of ['bullmq.jobs.completed', 'bullmq.jobs.failed', 'messaging.process.duration', 'bullmq.job.wait_time']) {
      expect(await points(n)).toHaveLength(0);
    }
  });
});

describe('patch lifecycle', () => {
  it('skips absent classes', () => {
    expect(() => patchBullmq({})).not.toThrow();
    expect(() => patchBullmq({ Worker: class {} })).not.toThrow();
  });
  it('unpatch restores', () => {
    const m = makeModule();
    const t = m.QueueBase.prototype.trace;
    const c = m.Worker.prototype.callProcessJob;
    patchBullmq(m);
    expect(m.QueueBase.prototype.trace).not.toBe(t);
    unpatchBullmq(m);
    expect(m.QueueBase.prototype.trace).toBe(t);
    expect(m.Worker.prototype.callProcessJob).toBe(c);
    expect(Object.hasOwn(m.FlowProducer.prototype, 'telemetry')).toBe(false);
  });
});
