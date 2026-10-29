import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { type OtlpReceiver, startOtlpReceiver } from '../e2e/helpers/otlp-receiver';
import { spawnApp } from '../e2e/helpers/spawn-app';

const ERROR = 2;
const SECRET = 'hunter2-SECRET';

const urls = inject('dbUrls');

let receiver: OtlpReceiver;
beforeEach(async () => {
  receiver = await startOtlpReceiver();
});
afterEach(async () => {
  await receiver.close();
});

describe.skipIf(!urls)('queues (bullmq)', () => {
  describe.each(['esm', 'cjs'] as const)('via %s', (entry) => {
    const start = () =>
      spawnApp({
        entry,
        preload: entry === 'esm',
        receiver,
        env: { QUEUE: 'bullmq', REDIS_URL: urls!.redis },
      });
    const named = (name: string) => () => receiver.spans().find((s) => s.name === name);

    it('trace chain: server → controller → service → add → process → processor', async () => {
      const app = await start();
      expect((await app.post('/jobs', { to: 'a@b.c' })).status).toBe(201);
      const processor = await receiver.waitFor(named('EmailsProcessor.process'));
      const enqueue = receiver.spans().find((s) => s.name === 'JobsService.enqueue')!;
      const add = receiver.spans().find((s) => s.name === 'add emails')!;
      const proc = receiver.spans().find((s) => s.name === 'process emails')!;
      expect(enqueue).toBeDefined();
      expect(add.parentSpanId).toBe(enqueue.spanId);
      expect(proc.parentSpanId).toBe(add.spanId);
      expect(processor.parentSpanId).toBe(proc.spanId);
      const server = receiver.spans().find((s) => s.name.startsWith('POST') && s.traceId === enqueue.traceId)!;
      expect(server).toBeDefined();
      for (const s of [enqueue, add, proc, processor]) expect(s.traceId).toBe(server.traceId);
    });

    it('failed job: processor span holds the stack, process span the status', async () => {
      const app = await start();
      expect((await app.post('/jobs', { to: 'a@b.c', password: SECRET, fail: true })).status).toBe(201);
      const processor = await receiver.waitFor(
        () => receiver.spans().find((s) => s.name === 'EmailsProcessor.process' && s.status.code === ERROR),
      );
      const proc = await receiver.waitFor(
        () => receiver.spans().find((s) => s.name === 'process emails' && s.status.code === ERROR),
      );
      await app.stop();
      const exc = processor.events.filter((e) => e.name === 'exception');
      expect(exc).toHaveLength(1);
      expect(String(exc[0]!.attributes['exception.stacktrace'])).toContain('EmailsProcessor.process');
      expect(proc.events.filter((e) => e.name === 'exception')).toHaveLength(0);
      expect(String(proc.attributes['bullmq.job.data'])).toContain('[REDACTED]');
      expect(JSON.stringify(receiver.spans())).not.toContain(SECRET);
    });

    it('success leaks nothing', async () => {
      const app = await start();
      expect((await app.post('/jobs', { to: 'a@b.c', password: SECRET })).status).toBe(201);
      await receiver.waitFor(named('process emails'));
      await app.stop();
      const all = JSON.stringify(receiver.spans());
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain('tok-SECRET');
    });

    it('job metrics exported', async () => {
      const app = await start();
      expect((await app.post('/jobs', { to: 'a@b.c' })).status).toBe(201);
      await receiver.waitFor(
        () =>
          receiver.metricNames().includes('bullmq.jobs.completed') &&
          receiver.metricNames().includes('messaging.process.duration'),
      );
      await app.stop();
    });
  });
});
