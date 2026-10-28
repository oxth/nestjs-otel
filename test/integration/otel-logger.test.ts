import { logs, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordError } from '../../src/errors/record';
import { OtelLogger } from '../../src/logs/otel-logger';
import { otelPinoMixin } from '../../src/pino';
import { SCOPE_NAME } from '../../src/shared/constants';
import { setupInMemoryTracing } from './helpers/tracing';

const tracing = setupInMemoryTracing();
const logExporter = new InMemoryLogRecordExporter();
const logProvider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logExporter })] });
logs.disable();
logs.setGlobalLoggerProvider(logProvider);

const tracer = trace.getTracer('test');
let out: string[];
let err: string[];

beforeEach(() => {
  logExporter.reset();
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await logProvider.shutdown();
  logs.disable();
});

function inSpan<T>(fn: (span: ReturnType<typeof tracer.startSpan>) => T): T {
  return tracer.startActiveSpan('op', (span) => {
    try {
      return fn(span);
    } finally {
      span.end();
    }
  });
}

const exceptionEvents = () =>
  tracing
    .spans()
    .flatMap((s) => s.events)
    .filter((e) => e.name === 'exception');

describe('OtelLogger', () => {
  it('emits OTLP record with trace context and nest.context', () => {
    const logger = new OtelLogger(undefined, { colors: false });
    const traceId = inSpan((span) => {
      logger.log('hi', 'Ctx');
      return span.spanContext().traceId;
    });
    const [record] = logExporter.getFinishedLogRecords();
    expect(record.body).toBe('hi');
    expect(record.severityNumber).toBe(9);
    expect(record.severityText).toBe('INFO');
    expect(record.spanContext?.traceId).toBe(traceId);
    expect(record.attributes['nest.context']).toBe('Ctx');
    expect(record.instrumentationScope.name).toBe(SCOPE_NAME);
  });

  it('redacts secret values in OTLP bodies and exception events', () => {
    const logger = new OtelLogger(undefined, { colors: false });
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    inSpan(() => {
      logger.log('calling upstream with Bearer abc.def-123');
      logger.error(`token ${jwt} rejected`, `Error: token ${jwt} rejected\n    at x (y.js:1:1)`);
    });
    const bodies = logExporter.getFinishedLogRecords().map((r) => r.body);
    expect(bodies).toEqual(['calling upstream with [REDACTED]', 'token [REDACTED] rejected']);
    const [ev] = exceptionEvents();
    expect(ev!.attributes!['exception.message']).toBe('token [REDACTED] rejected');
    expect(ev!.attributes!['exception.stacktrace']).toBe('Error: token [REDACTED] rejected\n    at x (y.js:1:1)');
  });

  it('stringifies object messages for the OTLP body', () => {
    const logger = new OtelLogger(undefined, { colors: false });
    logger.warn({ a: 1 });
    const [record] = logExporter.getFinishedLogRecords();
    expect(record.body).toBe('{"a":1}');
    expect(record.severityText).toBe('WARN');
  });

  it('console line includes trace_id only when a span is active', () => {
    const logger = new OtelLogger('Ctx', { colors: false });
    logger.log('outside');
    const { traceId, spanId } = inSpan((span) => {
      logger.log('inside');
      return span.spanContext();
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/\[Ctx\] outside\n$/);
    expect(out[0]).not.toContain('trace_id=');
    expect(out[1]).toMatch(new RegExp(`\\[Ctx\\] inside trace_id=${traceId} span_id=${spanId}\\n$`));
  });

  it('error with stack attaches exception event once per stack', () => {
    const logger = new OtelLogger(undefined, { colors: false });
    const stack = new Error('boom').stack!;
    inSpan(() => {
      logger.error('m', stack);
      logger.error('m', stack);
    });
    const events = exceptionEvents();
    expect(events).toHaveLength(1);
    expect(events[0].attributes).toMatchObject({ 'exception.message': 'm', 'exception.stacktrace': stack });
    expect(tracing.spans()[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(err.join('')).toContain(stack);
  });

  it('does not duplicate an error already recorded by recordError', () => {
    const logger = new OtelLogger(undefined, { colors: false });
    const e = new Error('db exploded', { cause: new Error('conn reset') });
    inSpan(() => {
      // recorded on a child span, logged (Nest style) on the parent span of the same trace
      tracer.startActiveSpan('child', (child) => {
        recordError(child, e, { treat4xxAsError: false });
        child.end();
      });
      logger.error(e.message, e.stack);
      logger.error(e);
    });
    expect(exceptionEvents()).toHaveLength(1);
  });

  it('records an Error logged as the message (Nest ExceptionsHandler style)', () => {
    const logger = new OtelLogger(undefined, { colors: false });
    const e = new Error('unrecorded', { cause: new Error('root') });
    inSpan(() => logger.error(e, 'ExceptionsHandler'));
    const events = exceptionEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.attributes!['exception.message']).toBe('unrecorded');
    expect(events[0]!.attributes!['exception.stacktrace']).toContain('Caused by: Error: root');
    expect(logExporter.getFinishedLogRecords()[0].body).toBe('unrecorded');
  });

  it('respects log levels and otlp:false / console:false', () => {
    const leveled = new OtelLogger(undefined, { colors: false, logLevels: ['warn'] });
    leveled.log('dropped');
    leveled.warn('kept');
    expect(logExporter.getFinishedLogRecords().map((r) => r.body)).toEqual(['kept']);
    expect(out).toHaveLength(1);

    logExporter.reset();
    out.length = 0;
    new OtelLogger(undefined, { colors: false, otlp: false }).log('console only');
    expect(logExporter.getFinishedLogRecords()).toHaveLength(0);
    expect(out).toHaveLength(1);

    out.length = 0;
    err.length = 0;
    const quiet = new OtelLogger(undefined, { colors: false, console: false });
    quiet.log('otlp only');
    quiet.error('bad', new Error('x').stack);
    expect(logExporter.getFinishedLogRecords().map((r) => r.body)).toEqual(['otlp only', 'bad']);
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(0);
  });

  it('never throws when telemetry fails', () => {
    const logger = new OtelLogger(undefined, { colors: false });
    const spy = vi.spyOn(logs, 'getLogger').mockImplementation(() => {
      throw new Error('broken provider');
    });
    expect(() => logger.log('still fine')).not.toThrow();
    expect(out.join('')).toContain('still fine');
    spy.mockRestore();
  });
});

describe('otelPinoMixin', () => {
  it('returns trace fields from the active span and {} without one', () => {
    const mixin = otelPinoMixin();
    expect(mixin()).toEqual({});
    const { ctx, fields } = inSpan((span) => ({ ctx: span.spanContext(), fields: mixin() }));
    expect(fields).toEqual({ trace_id: ctx.traceId, span_id: ctx.spanId, trace_flags: '01' });
  });
});
