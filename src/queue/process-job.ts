import { type Attributes, context, metrics, type Span, trace } from '@opentelemetry/api';
import { recordError } from '../errors/record';
import { getDefaultRedactor, serializeBody } from '../redact/redactor';
import { SCOPE_NAME } from '../shared/constants';
import { safely } from '../shared/safe';
import { getClassifyDefaults } from '../tracing/decorators';
import { isOwnBullmqTelemetry } from './bullmq-telemetry';
import { getBullmqSettings } from './settings';

type Outcome = 'completed' | 'failed' | 'delayed' | 'waiting' | 'waiting-children' | 'rate-limited';

/** Control-flow signals BullMQ processors throw on purpose; matched by `err.name`. */
function controlFlowOutcome(err: unknown): Outcome | undefined {
  const name = (err as { name?: unknown } | null)?.name;
  switch (name) {
    case 'DelayedError':
      return 'delayed';
    case 'WaitingError':
      return 'waiting';
    case 'WaitingChildrenError':
      return 'waiting-children';
    case 'RateLimitError':
      return 'rate-limited';
  }
  return (err as { message?: unknown } | null)?.message === 'bullmq:rateLimitExceeded' ? 'rate-limited' : undefined;
}

function instruments() {
  const meter = metrics.getMeter(SCOPE_NAME);
  return {
    completed: meter.createCounter('bullmq.jobs.completed'),
    failed: meter.createCounter('bullmq.jobs.failed'),
    duration: meter.createHistogram('messaging.process.duration', { unit: 's' }),
    wait: meter.createHistogram('bullmq.job.wait_time', { unit: 's' }),
  };
}

function metricsEnabled(worker: any): boolean {
  const t = worker?.opts?.telemetry;
  return !(t?.meter && !isOwnBullmqTelemetry(t));
}

function attachData(span: Span, job: any): void {
  safely(
    'attach job data',
    () => {
      const { body, truncated } = serializeBody(
        getDefaultRedactor().redact(job?.data),
        getBullmqSettings().maxDataBytes,
      );
      span.setAttribute('bullmq.job.data', body);
      if (truncated) span.setAttribute('bullmq.job.data.truncated', true);
    },
    undefined,
  );
}

function finish(
  worker: any,
  job: any,
  span: Span | undefined,
  startedAt: number,
  outcome: Outcome,
  err: unknown,
  attempt: number,
  max: number,
): void {
  const willRetry =
    outcome === 'failed' ? (err as { name?: unknown } | null)?.name !== 'UnrecoverableError' && attempt < max : undefined;
  safely(
    'bullmq span outcome',
    () => {
      if (!span) return;
      span.setAttribute('bullmq.job.outcome', outcome);
      if (willRetry !== undefined) span.setAttribute('bullmq.job.will_retry', willRetry);
      if (outcome === 'failed') recordError(span, err, getClassifyDefaults());
      const mode = getBullmqSettings().captureData;
      if (mode === 'always' || (mode === 'error' && outcome === 'failed')) attachData(span, job);
    },
    undefined,
  );
  safely(
    'bullmq metrics',
    () => {
      if (!metricsEnabled(worker)) return;
      const m = instruments();
      const base: Attributes = {
        'messaging.system': 'bullmq',
        'messaging.destination.name': String(worker?.name),
        'messaging.operation.name': 'process',
        'bullmq.job.name': String(job?.name),
      };
      if (outcome === 'completed') m.completed.add(1, base);
      if (outcome === 'failed') m.failed.add(1, { ...base, 'bullmq.job.will_retry': willRetry === true });
      const errType = outcome === 'failed' ? { 'error.type': String((err as Error)?.name ?? 'Error') } : {};
      m.duration.record((Date.now() - startedAt) / 1000, { ...base, ...errType });
      if ((job?.attemptsMade ?? 0) === 0) {
        const wait = Math.max(0, (job?.processedOn ?? Date.now()) - ((job?.timestamp ?? 0) + (job?.delay ?? 0)));
        m.wait.record(wait / 1000, base);
      }
    },
    undefined,
  );
}

/**
 * Runs `run` (the original `Worker.callProcessJob`) and records attempt attributes, failures, job data and
 * metrics on the active `process` span. The processor's result or rejection passes through unchanged.
 */
export function runProcessJob<T>(worker: any, job: any, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const span = safely<Span | undefined>('bullmq active span', () => trace.getSpan(context.active()), undefined);
  const attempt = safely('bullmq attempt', () => Number(job?.attemptsMade ?? 0) + 1, 1);
  const max = safely('bullmq max attempts', () => Number(job?.opts?.attempts ?? 1), 1);
  safely(
    'bullmq attempt attributes',
    () => {
      span?.setAttribute('bullmq.job.attempt', attempt);
      span?.setAttribute('bullmq.job.attempts.max', max);
    },
    undefined,
  );

  let promise: Promise<T>;
  try {
    promise = run();
  } catch (err) {
    onFail(err);
    throw err;
  }
  return promise.then(
    (value) => {
      finish(worker, job, span, startedAt, 'completed', undefined, attempt, max);
      return value;
    },
    (err) => {
      onFail(err);
      throw err;
    },
  );

  function onFail(err: unknown): void {
    const outcome = safely('bullmq classify', () => controlFlowOutcome(err), undefined) ?? 'failed';
    if (outcome !== 'failed') {
      // Control flow: only the outcome attribute; no error status, exception or failure metric.
      safely('bullmq control flow', () => span?.setAttribute('bullmq.job.outcome', outcome), undefined);
      return;
    }
    finish(worker, job, span, startedAt, 'failed', err, attempt, max);
  }
}
