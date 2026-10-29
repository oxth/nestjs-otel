import { context, metrics, SpanKind, SpanStatusCode, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { createRequire } from 'node:module';
import { BullMQOtel } from 'bullmq-otel';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { patchBullmq, unpatchBullmq } from '../../src/queue/bullmq';
import { setupInMemoryTracing } from '../integration/helpers/tracing';

const SECRET = 'hunter2-SECRET';
const urls = inject('dbUrls');

// `BULLMQ_VERSION` (as for the spawned fixture) picks the BullMQ this in-process suite loads:
// major 5 → the `bullmq-5` alias (pinned to 5.24.0, the supported floor), anything else → `bullmq` (v6).
const BULLMQ_MAJOR = Number(/\d+/.exec(process.env.BULLMQ_VERSION ?? '6')?.[0] ?? 6);
const BULLMQ_MODULE = BULLMQ_MAJOR === 5 ? 'bullmq-5' : 'bullmq';
const BULLMQ_LOADED_VERSION: string = createRequire(import.meta.url)(`${BULLMQ_MODULE}/package.json`).version;
let bullmq: any;

const t = setupInMemoryTracing();
const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
const provider = new MeterProvider({ readers: [reader] });

async function collect(name: string) {
  await reader.forceFlush();
  return exporter
    .getMetrics()
    .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
    .filter((m) => m.descriptor.name === name)
    .at(-1);
}

async function waitFor<T>(fn: () => T | undefined | false, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const waitForSpans = (pred: (spans: ReadableSpan[]) => boolean, timeout = 5000) =>
  waitFor(() => (pred(t.spans()) ? t.spans() : false), timeout);
const named = (prefix: string) => (spans: ReadableSpan[]) => spans.filter((s) => s.name.startsWith(prefix));
const dump = (spans: ReadableSpan[]): string =>
  JSON.stringify(
    spans.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, status: s.status, links: s.links })),
  );
const parentId = (s: ReadableSpan): string | undefined => s.parentSpanContext?.spanId;

describe.skipIf(!urls)('bullmq against Redis', () => {
  let n = 0;
  const closers: Array<() => Promise<unknown>> = [];
  let connection: Redis;
  const tracer = () => trace.getTracer('test');

  beforeAll(async () => {
    bullmq = await import(BULLMQ_MODULE);
    console.info(`bullmq.db.test: ${BULLMQ_MODULE}@${BULLMQ_LOADED_VERSION}`);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    metrics.disable();
    metrics.setGlobalMeterProvider(provider);
    patchBullmq(bullmq);
    connection = new Redis(urls!.redis, { maxRetriesPerRequest: null });
  });
  afterAll(async () => {
    unpatchBullmq(bullmq);
    connection.disconnect();
    await provider.shutdown();
    metrics.disable();
    propagation.disable();
  });
  afterEach(async () => {
    exporter.reset();
    await Promise.allSettled(closers.splice(0).reverse().map((c) => c()));
  });

  it(`loads the BullMQ selected by BULLMQ_VERSION (${BULLMQ_MODULE}@${BULLMQ_LOADED_VERSION})`, () => {
    expect(BULLMQ_LOADED_VERSION.split('.')[0]).toBe(String(BULLMQ_MAJOR));
    if (BULLMQ_MAJOR === 5) expect(BULLMQ_LOADED_VERSION).toBe('5.24.0');
    // The patch landed on the module this suite uses.
    expect(bullmq.QueueBase.prototype.trace).not.toBe(undefined);
    expect(Object.hasOwn(bullmq.FlowProducer.prototype, 'telemetry')).toBe(true);
  });

  const qname = () => `emails-${++n}`;
  const queue = (name: string, opts: Record<string, unknown> = {}) => {
    const q = new bullmq.Queue(name, { connection, ...opts });
    closers.push(() => q.close());
    return q;
  };
  const worker = (name: string, proc: (job: any, token?: string) => Promise<unknown>, opts = {}) => {
    const w = new bullmq.Worker(name, proc, { connection, drainDelay: 1, stalledInterval: 500, ...opts });
    closers.push(() => w.close());
    return w;
  };

  it('add → process: consumer is child of producer', async () => {
    const q = qname();
    const queueI = queue(q);
    worker(q, async () => 'ok');
    await tracer().startActiveSpan('caller', async (caller) => {
      await queueI.add('send', { to: 'a' });
      caller.end();
    });
    const spans = await waitForSpans((s) => s.some((x) => x.name === `process ${q}`));
    const caller = spans.find((s) => s.name === 'caller')!;
    const add = spans.find((s) => s.name === `add ${q}`)!;
    const proc = spans.find((s) => s.name === `process ${q}`)!;
    expect(add.kind).toBe(SpanKind.PRODUCER);
    expect(parentId(add)).toBe(caller.spanContext().spanId);
    expect(proc.kind).toBe(SpanKind.CONSUMER);
    expect(parentId(proc)).toBe(add.spanContext().spanId);
    expect(proc.spanContext().traceId).toBe(caller.spanContext().traceId);
    expect(proc.attributes['messaging.message.id']).toBeDefined();
    // BullMQ 5.24 does not set `bullmq.job.name` on its `process` span; v6 does.
    expect(proc.attributes['bullmq.job.name']).toBe(BULLMQ_MAJOR >= 6 ? 'send' : undefined);
    expect(proc.attributes['bullmq.job.outcome']).toBe('completed');
  });

  it('addBulk: one span, process spans are its children', async () => {
    const q = qname();
    const queueI = queue(q);
    worker(q, async () => 'ok');
    await queueI.addBulk([
      { name: 'a', data: {} },
      { name: 'b', data: {} },
    ]);
    const spans = await waitForSpans((s) => named(`process ${q}`)(s).length === 2);
    const bulk = named(`addBulk ${q}`)(spans);
    expect(bulk).toHaveLength(1);
    expect(bulk[0].attributes['messaging.batch.message_count']).toBe(2);
    for (const p of named(`process ${q}`)(spans)) expect(parentId(p)).toBe(bulk[0].spanContext().spanId);
  });

  it('FlowProducer: child and parent processing are in the addFlow trace', async () => {
    const parentQ = qname();
    const childQ = qname();
    const flow = new bullmq.FlowProducer({ connection });
    closers.push(() => flow.close());
    worker(parentQ, async () => 'p');
    worker(childQ, async () => 'c');
    // BullMQ's FlowProducer only propagates trace context to nodes that carry an `opts` object
    // (addNode: `if (srcPropagationMetadata && opts)`), so the nodes pass an empty one.
    await flow.add({
      name: 'parent',
      queueName: parentQ,
      data: {},
      opts: {},
      children: [{ name: 'child', queueName: childQ, data: {}, opts: {} }],
    });
    const spans = await waitForSpans(
      (s) => named(`process ${parentQ}`)(s).length === 1 && named(`process ${childQ}`)(s).length === 1,
    );
    const flowSpan = spans.find((s) => s.name === `addFlow ${parentQ}`)!;
    expect(flowSpan).toBeDefined();
    const trace = flowSpan.spanContext().traceId;
    expect(named(`process ${childQ}`)(spans)[0].spanContext().traceId).toBe(trace);
    expect(named(`process ${parentQ}`)(spans)[0].spanContext().traceId).toBe(trace);
    // addNode spans keep BullMQ's `addNode <queue>` name on both majors (5.24 passes the job name as queue name).
    const childNode = spans.find((s) => s.name === `addNode ${childQ}`);
    expect(childNode?.attributes['messaging.destination.name']).toBe(childQ);
    expect(spans.some((s) => s.name === 'addNode child' || s.name === 'addNode parent')).toBe(false);
  });

  it('idle worker records no spans', async () => {
    const q = qname();
    const w = worker(q, async () => 'ok');
    await w.waitUntilReady();
    // Long enough for several polls and at least two stalled-job checks (stalledInterval is 500ms).
    await new Promise((r) => setTimeout(r, 2 * 500 + 1000));
    expect(t.spans()).toEqual([]);
  });

  it('failure: error with stack, redacted data, attempts', async () => {
    const q = qname();
    const queueI = queue(q);
    async function failingProcessor(): Promise<void> {
      throw new Error('smtp down');
    }
    worker(q, failingProcessor);
    await queueI.add('send', { password: SECRET, to: 'a' }, { attempts: 2, backoff: { type: 'fixed', delay: 10 } });
    const spans = await waitForSpans((s) => named(`process ${q}`)(s).length === 2);
    const add = spans.find((s) => s.name === `add ${q}`)!;
    const procs = named(`process ${q}`)(spans).sort(
      (a, b) => (a.attributes['bullmq.job.attempt'] as number) - (b.attributes['bullmq.job.attempt'] as number),
    );
    expect(procs.map((p) => p.attributes['bullmq.job.attempt'])).toEqual([1, 2]);
    expect(procs.map((p) => p.attributes['bullmq.job.will_retry'])).toEqual([true, false]);
    for (const p of procs) {
      // Both attempts are children of `add` (5.24's retry rewrites the job metadata; see getMetadata).
      expect(parentId(p)).toBe(add.spanContext().spanId);
      expect(p.spanContext().traceId).toBe(add.spanContext().traceId);
      expect(p.status.code).toBe(SpanStatusCode.ERROR);
      const ex = p.events.find((e) => e.name === 'exception');
      expect(ex).toBeDefined();
      expect(String(ex!.attributes?.['exception.stacktrace'])).toContain('failingProcessor');
      expect(String(p.attributes['bullmq.job.data'])).toContain('[REDACTED]');
    }
    expect(dump(t.spans())).not.toContain(SECRET);
    const failed = await collect('bullmq.jobs.failed');
    const total = (failed?.dataPoints ?? [])
      .filter((d) => d.attributes['messaging.destination.name'] === q)
      .reduce((sum, d) => sum + (d.value as number), 0);
    expect(total).toBe(2);
  });

  it('secret never leaks on success', async () => {
    const q = qname();
    const queueI = queue(q);
    worker(q, async () => ({ token: SECRET }));
    await queueI.add('send', { password: SECRET });
    const spans = await waitForSpans((s) => s.some((x) => x.name === `process ${q}`));
    // Let the "completed" bookkeeping settle.
    await new Promise((r) => setTimeout(r, 200));
    for (const s of t.spans()) expect(s.attributes['bullmq.job.data']).toBeUndefined();
    expect(dump(spans)).not.toContain(SECRET);
    expect(dump(t.spans())).not.toContain(SECRET);
  });

  it('DelayedError is not an error', async () => {
    const q = qname();
    const queueI = queue(q);
    let first = true;
    worker(q, async (job, token) => {
      if (first) {
        first = false;
        await job.moveToDelayed(Date.now() + 50, token);
        throw new bullmq.DelayedError();
      }
      return 'done';
    });
    await queueI.add('send', {});
    const spans = await waitForSpans((s) => named(`process ${q}`)(s).length >= 2);
    const procs = named(`process ${q}`)(spans).sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]);
    expect(procs[0].status.code).toBe(SpanStatusCode.UNSET);
    expect(procs[0].attributes['bullmq.job.outcome']).toBe('delayed');
    expect(procs.some((p) => p.attributes['bullmq.job.outcome'] === 'completed')).toBe(true);
  });

  it('app-supplied telemetry is respected and interoperates', async () => {
    const q = qname();
    const queueI = queue(q, { telemetry: new BullMQOtel({ tracerName: 'app' }) });
    worker(q, async () => 'ok');
    await queueI.add('send', {});
    const spans = await waitForSpans((s) => s.some((x) => x.name === `process ${q}`));
    const adds = spans.filter((s) => s.name.startsWith('add '));
    expect(adds).toHaveLength(1);
    expect(adds[0].instrumentationScope.name).toBe('app');
    const proc = spans.find((s) => s.name === `process ${q}`)!;
    expect(parentId(proc)).toBe(adds[0].spanContext().spanId);
  });

  /**
   * A Queue whose (app-supplied, so never replaced) telemetry records nothing and propagates no context:
   * its jobs carry no trace metadata on every BullMQ major (5.24 ignores `telemetry.omitContext`).
   */
  const contextlessQueue = (name: string) => {
    const span = {
      setSpanOnContext: (ctx: unknown) => ctx ?? context.active(),
      setAttribute: () => span,
      setAttributes: () => span,
      addEvent: () => span,
      recordException: () => {},
      end: () => {},
    };
    return queue(name, {
      telemetry: {
        tracer: { startSpan: () => span },
        contextManager: {
          with: (ctx: any, fn: () => unknown) => context.with(ctx, fn),
          active: () => context.active(),
          getMetadata: () => '',
          fromMetadata: (ctx: unknown) => ctx,
        },
      },
    });
  };

  it('worker created inside a span does not adopt it; the processor runs under process', async () => {
    const q = qname();
    const queueI = contextlessQueue(q);
    await tracer().startActiveSpan('boot', async (span) => {
      worker(q, async () => {
        tracer().startSpan('EmailsProcessor.process').end();
        return 'ok';
      });
      span.end();
    });
    await new Promise((r) => setTimeout(r, 100));
    const job = await queueI.add('send', {});
    expect(job.opts.telemetryMetadata ?? job.opts.telemetry?.metadata).toBeFalsy();
    const spans = await waitForSpans((s) => s.some((x) => x.name === `process ${q}`) && s.some((x) => x.name === 'EmailsProcessor.process'));
    const boot = spans.find((s) => s.name === 'boot')!;
    const proc = spans.find((s) => s.name === `process ${q}`)!;
    const child = spans.find((s) => s.name === 'EmailsProcessor.process')!;
    // No propagated context: the only way `process` could get a parent is the worker's creation context.
    expect(parentId(proc)).toBeUndefined();
    expect(proc.spanContext().traceId).not.toBe(boot.spanContext().traceId);
    // The processor runs under `process` (BullMQ 5.24 passes no context to setSpanOnContext here).
    expect(parentId(child)).toBe(proc.spanContext().spanId);
    expect(proc.attributes['bullmq.job.outcome']).toBe('completed');
    expect(proc.attributes['bullmq.job.attempt']).toBe(1);
  });

  it.runIf(BULLMQ_MAJOR >= 6)('v6 telemetry.omitContext: process is a root under the process span', async () => {
    const q = qname();
    const queueI = queue(q);
    await tracer().startActiveSpan('boot', async (span) => {
      worker(q, async () => {
        tracer().startSpan('EmailsProcessor.process').end();
        return 'ok';
      });
      span.end();
    });
    await new Promise((r) => setTimeout(r, 100));
    await queueI.add('send', {}, { telemetry: { omitContext: true } });
    const spans = await waitForSpans((s) => s.some((x) => x.name === `process ${q}`) && s.some((x) => x.name === 'EmailsProcessor.process'));
    const boot = spans.find((s) => s.name === 'boot')!;
    const proc = spans.find((s) => s.name === `process ${q}`)!;
    expect(parentId(proc)).toBeUndefined();
    expect(proc.spanContext().traceId).not.toBe(boot.spanContext().traceId);
    expect(parentId(spans.find((s) => s.name === 'EmailsProcessor.process')!)).toBe(proc.spanContext().spanId);
  });

  it('after pause() and resume() the processor is still recorded', async () => {
    const q = qname();
    const queueI = queue(q);
    const w = worker(q, async () => {
      tracer().startSpan('EmailsProcessor.process').end();
      return 'ok';
    });
    await w.waitUntilReady();
    await w.pause();
    // v6 restarts the main loop inside the non-recorded (suppressed) `resume` operation.
    w.resume();
    await new Promise((r) => setTimeout(r, 100));
    await queueI.add('send', {});
    const spans = await waitForSpans((s) => s.some((x) => x.name === `process ${q}`) && s.some((x) => x.name === 'EmailsProcessor.process'));
    const add = spans.find((s) => s.name === `add ${q}`)!;
    const proc = spans.find((s) => s.name === `process ${q}`)!;
    expect(parentId(proc)).toBe(add.spanContext().spanId);
    expect(parentId(spans.find((s) => s.name === 'EmailsProcessor.process')!)).toBe(proc.spanContext().spanId);
    expect(proc.attributes['bullmq.job.outcome']).toBe('completed');
  });

  it('metrics', async () => {
    const q = qname();
    const queueI = queue(q);
    worker(q, async () => 'ok');
    await queueI.add('send', {});
    await waitForSpans((s) => s.some((x) => x.name === `process ${q}`));
    const forQueue = async (name: string) =>
      (await collect(name))?.dataPoints.filter((d) => d.attributes['messaging.destination.name'] === q) ?? [];
    const completed = await forQueue('bullmq.jobs.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].value).toBe(1);
    expect(await forQueue('messaging.process.duration')).toHaveLength(1);
    expect(await forQueue('bullmq.job.wait_time')).toHaveLength(1);
  });
});
