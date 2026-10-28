import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BadRequestException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { beforeEach, describe, expect, it } from 'vitest';
import { classifyError } from '../../src/errors/classify';
import { formatStack, hasStackRecorded, recordError } from '../../src/errors/record';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer('t');
const opts = { treat4xxAsError: false };

beforeEach(() => exporter.reset());

describe('errors', () => {
  it('4xx HttpException is not an error by default', () => {
    expect(classifyError(new NotFoundException(), { treat4xxAsError: false })).toEqual({ isError: false, httpStatus: 404 });
    expect(classifyError(new NotFoundException(), { treat4xxAsError: true }).isError).toBe(true);
  });
  it('5xx, plain Error, RpcException and strings are errors', () => {
    for (const e of [new InternalServerErrorException(), new Error('x'), new RpcException('r'), 'str'])
      expect(classifyError(e, { treat4xxAsError: false }).isError).toBe(true);
  });
  it('duck-typed getStatus works', () => {
    expect(classifyError({ getStatus: () => 409, message: 'c' }, { treat4xxAsError: false })).toEqual({ isError: false, httpStatus: 409 });
  });
  it('formatStack includes cause chain and survives cycles', () => {
    const a: any = new Error('a');
    const b: any = new Error('b', { cause: a });
    a.cause = b;
    const s = formatStack(b);
    expect(s).toContain('Error: b');
    expect(s).toContain('Caused by: Error: a');
    expect(s.split('Caused by:').length).toBeLessThanOrEqual(6);
  });
  it('records exception event once, error status on every span', () => {
    const err = new Error('boom');
    const inner = tracer.startSpan('inner');
    const outer = tracer.startSpan('outer');
    recordError(inner, err, opts);
    recordError(outer, err, opts);
    inner.end();
    outer.end();
    const [i, o] = exporter.getFinishedSpans();
    expect(i.events.map((e) => e.name)).toEqual(['exception']);
    expect(i.events[0].attributes!['exception.stacktrace']).toContain('boom');
    expect(i.events[0].attributes!['exception.type']).toBe('Error');
    expect(o.events).toHaveLength(0);
    expect(i.status.code).toBe(SpanStatusCode.ERROR);
    expect(o.status.code).toBe(SpanStatusCode.ERROR);
  });
  it('marks the recorded stack on the span', () => {
    const err = new Error('boom');
    const s = tracer.startSpan('s');
    recordError(s, err, opts);
    expect(hasStackRecorded(s, formatStack(err))).toBe(true);
    expect(hasStackRecorded(s, 'other')).toBe(false);
  });
  it('a stack recorded anywhere in the trace counts, including its head before "Caused by"', () => {
    const err = new Error('boom', { cause: new Error('root') });
    const inner = tracer.startSpan('inner');
    recordError(inner, err, opts);
    const sibling = tracer.startSpan('sibling', undefined, trace.setSpan(context.active(), inner));
    expect(hasStackRecorded(sibling, formatStack(err))).toBe(true);
    expect(hasStackRecorded(sibling, err.stack!)).toBe(true);
    expect(hasStackRecorded(sibling, err.stack!.slice(0, 10))).toBe(false);
    expect(hasStackRecorded(tracer.startSpan('other trace'), err.stack!)).toBe(false);
  });
  it('primitive throws are always recorded as events', () => {
    const s = tracer.startSpan('s');
    recordError(s, 'oops', opts);
    recordError(s, 'oops', opts);
    s.end();
    const [f] = exporter.getFinishedSpans();
    expect(f.events.map((e) => e.name)).toEqual(['exception', 'exception']);
    expect(f.events[0].attributes!['exception.message']).toBe('oops');
    expect(f.status.code).toBe(SpanStatusCode.ERROR);
  });
  it('4xx records exception.handled and leaves status unset', () => {
    const s = tracer.startSpan('s');
    recordError(s, new BadRequestException('bad'), opts);
    s.end();
    const [f] = exporter.getFinishedSpans();
    expect(f.events[0].name).toBe('exception.handled');
    expect(f.events[0].attributes!['http.response.status_code']).toBe(400);
    expect(f.attributes['error.expected']).toBe(true);
    expect(f.status.code).toBe(SpanStatusCode.UNSET);
  });
});
