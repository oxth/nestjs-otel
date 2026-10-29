import { BadRequestException, Controller, Get, Injectable, SetMetadata } from '@nestjs/common';
import { EventPattern, MessagePattern, RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { context, metrics, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  AggregationTemporality,
  type DataPoint,
  type Histogram,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { lastValueFrom, type Observable, of } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { injectContext, NoTrace, type OtelModuleOptions, OtelModule } from '../../src/index';
import { describeHandler } from '../../src/microservices/handler';
import { setupInMemoryTracing } from './helpers/tracing';

const t = setupInMemoryTracing();
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
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
  return exporter
    .getMetrics()
    .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
    .filter((m) => m.descriptor.name === name)
    .at(-1);
}

async function points(name: string, destination: string) {
  const m = await collect(name);
  return (m?.dataPoints ?? []).filter((p) => p.attributes['messaging.destination.name'] === destination) as DataPoint<
    unknown
  >[];
}

// Fake contexts: the library recognises transports by constructor name.
class TcpContext {
  constructor(private readonly pattern = 'users.get') {}
  getPattern() {
    return this.pattern;
  }
}
class KafkaContext {
  constructor(private readonly topic = 'orders') {}
  getTopic() {
    return this.topic;
  }
}
class RedisContext {}

@Controller()
class RpcController {
  @MessagePattern('users.get')
  get(data: unknown, _ctx?: unknown): unknown {
    return { ok: true, data };
  }

  @EventPattern('user.created')
  created(_data: unknown, _ctx?: unknown): void {}

  @MessagePattern('orders')
  order(_data: unknown, _ctx?: unknown): string {
    return 'ok';
  }

  @MessagePattern({ cmd: 'sum' })
  sum(data: number[], _ctx?: unknown): number {
    return data.reduce((a, b) => a + b, 0);
  }

  @MessagePattern('users.fail')
  fail(_data: unknown, _ctx?: unknown): never {
    throw new RpcException('bad');
  }

  @MessagePattern('users.stream')
  stream(_data: unknown, _ctx?: unknown): Observable<number> {
    return of(1, 2);
  }

  @MessagePattern('orders.async')
  async failAsync(_data: unknown, _ctx?: unknown): Promise<never> {
    await new Promise((r) => setTimeout(r, 5));
    throw new Error('later');
  }

  @MessagePattern('users.expected')
  expected(_data: unknown, _ctx?: unknown): never {
    throw new BadRequestException('nope');
  }

  @Get('plain')
  plain(): string {
    return 'plain';
  }
}

async function build(o?: OtelModuleOptions): Promise<RpcController> {
  const moduleRef = await Test.createTestingModule({
    imports: [OtelModule.forRoot(o)],
    controllers: [RpcController],
  }).compile();
  return moduleRef.get(RpcController);
}

const byName = (name: string): ReadableSpan | undefined => t.spans().find((s) => s.name === name);

describe('microservice handler spans', () => {
  let c: RpcController;
  beforeAll(async () => {
    c = await build();
  });

  it('message handler', () => {
    c.get({ id: 1 }, new TcpContext());
    const span = byName('RpcController.get')!;
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.attributes).toMatchObject({
      'messaging.system': 'tcp',
      'messaging.destination.name': 'users.get',
      'messaging.operation.type': 'process',
      'nestjs.microservice.kind': 'message',
      'nestjs.microservice.pattern': 'users.get',
    });
  });

  it('event handler', () => {
    c.created({ id: 2 }, new TcpContext());
    const span = byName('RpcController.created')!;
    expect(span.kind).toBe(SpanKind.CONSUMER);
    expect(span.attributes['nestjs.microservice.kind']).toBe('event');
    expect(span.attributes['nestjs.microservice.pattern']).toBe('user.created');
  });

  it('kafka destination comes from getTopic()', () => {
    c.order({}, new KafkaContext());
    const span = byName('RpcController.order')!;
    expect(span.attributes).toMatchObject({
      'messaging.system': 'kafka',
      'messaging.destination.name': 'orders',
    });
  });

  it('object pattern', () => {
    c.sum([1, 2], new RedisContext());
    const span = byName('RpcController.sum')!;
    expect(span.attributes).toMatchObject({
      'messaging.system': 'redis',
      'messaging.destination.name': '{"cmd":"sum"}',
      'nestjs.microservice.pattern': '{"cmd":"sum"}',
    });
  });

  it('without a recognised context, the system is nestjs', () => {
    c.get({ id: 1 });
    const span = byName('RpcController.get')!;
    expect(span.attributes).toMatchObject({
      'messaging.system': 'nestjs',
      'messaging.destination.name': 'users.get',
    });
  });

  it('plain controller methods are unchanged', () => {
    c.plain();
    const span = byName('RpcController.plain')!;
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(Object.keys(span.attributes).filter((k) => k.startsWith('messaging.') || k.startsWith('nestjs.'))).toEqual(
      [],
    );
    expect(describeHandler(RpcController.prototype, 'plain')).toBeUndefined();
  });

  it('failure', async () => {
    expect(() => c.fail({ password: 'p', a: 1 }, new TcpContext('users.fail'))).toThrow(RpcException);
    const span = byName('RpcController.fail')!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.filter((e) => e.name === 'exception')).toHaveLength(1);
    const data = String(span.attributes['nestjs.microservice.data']);
    expect(data).toContain('[REDACTED]');
    expect(data).not.toContain('"p"');
    expect(data).toContain('"a":1');

    const errors = await points('nestjs.microservice.handler.errors', 'users.fail');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.value).toBe(1);
    expect(errors[0]!.attributes).toMatchObject({
      'messaging.system': 'tcp',
      'messaging.operation.name': 'process',
      'error.type': 'RpcException',
    });
    const durations = await points('messaging.process.duration', 'users.fail');
    const failed = durations.find((p) => p.attributes['error.type'] === 'RpcException');
    expect(failed).toBeDefined();
    expect((failed!.value as Histogram).count).toBe(1);
    const m = await collect('messaging.process.duration');
    expect(m?.descriptor.unit).toBe('s');
  });

  it('success records duration, no data', async () => {
    c.order({ password: 'x' }, new KafkaContext());
    const span = byName('RpcController.order')!;
    expect(span.attributes['nestjs.microservice.data']).toBeUndefined();
    const durations = await points('messaging.process.duration', 'orders');
    expect(durations).toHaveLength(1);
    expect(durations[0]!.attributes).toEqual({
      'messaging.system': 'kafka',
      'messaging.destination.name': 'orders',
      'messaging.operation.name': 'process',
    });
    expect(await points('nestjs.microservice.handler.errors', 'orders')).toHaveLength(0);
  });

  it('observable handler', async () => {
    const out = c.stream({}, new TcpContext('users.stream')) as Observable<number>;
    expect(byName('RpcController.stream')).toBeUndefined();
    expect(await points('messaging.process.duration', 'users.stream')).toHaveLength(0);
    expect(await lastValueFrom(out)).toBe(2);
    expect(byName('RpcController.stream')).toBeDefined();
    const durations = await points('messaging.process.duration', 'users.stream');
    expect(durations).toHaveLength(1);
    expect((durations[0]!.value as Histogram).count).toBe(1);
  });

  it('async failure settles once, after rejection', async () => {
    const p = c.failAsync({ token: 't' }, new KafkaContext('orders.async')) as Promise<never>;
    expect(byName('RpcController.failAsync')).toBeUndefined();
    await expect(p).rejects.toThrow('later');
    const span = byName('RpcController.failAsync')!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(String(span.attributes['nestjs.microservice.data'])).toContain('[REDACTED]');
    const errors = await points('nestjs.microservice.handler.errors', 'orders.async');
    expect(errors.map((e) => [e.value, e.attributes['error.type']])).toEqual([[1, 'Error']]);
  });

  it('a non-error (4xx-style) exception is not counted as a failure', async () => {
    expect(() => c.expected({ password: 'x' }, new TcpContext('users.expected'))).toThrow();
    const span = byName('RpcController.expected')!;
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span.attributes['nestjs.microservice.data']).toBeUndefined();
    expect(await points('nestjs.microservice.handler.errors', 'users.expected')).toHaveLength(0);
    const d = await points('messaging.process.duration', 'users.expected');
    expect(d.map((p) => p.attributes['error.type'])).toEqual([undefined]);
  });
});

describe('handler instruments per MeterProvider', () => {
  it('a MeterProvider registered later gets the handler metrics', async () => {
    const c = await build();
    c.order({}, new KafkaContext('orders.before'));
    const laterExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const laterReader = new PeriodicExportingMetricReader({ exporter: laterExporter, exportIntervalMillis: 3_600_000 });
    const later = new MeterProvider({ readers: [laterReader] });
    metrics.disable();
    metrics.setGlobalMeterProvider(later);
    try {
      c.order({}, new KafkaContext('orders.later'));
      c.order({}, new KafkaContext('orders.later'));
      await laterReader.forceFlush();
      const pts = laterExporter
        .getMetrics()
        .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
        .filter((m) => m.descriptor.name === 'messaging.process.duration')
        .flatMap((m) => m.dataPoints as DataPoint<unknown>[]);
      expect(pts.map((p) => [p.attributes['messaging.destination.name'], (p.value as Histogram).count])).toEqual([
        ['orders.later', 2],
      ]);
    } finally {
      await later.shutdown();
      metrics.disable();
      metrics.setGlobalMeterProvider(provider);
    }
    c.order({}, new KafkaContext('orders.after'));
    expect(await points('messaging.process.duration', 'orders.after')).toHaveLength(1);
  });
});

describe('payload capture modes', () => {
  it("captureData: 'always' records data on success, redacted", async () => {
    const c = await build({ microservices: { captureData: 'always' } });
    c.get({ id: 1, password: 'secret' }, new TcpContext());
    const data = String(byName('RpcController.get')!.attributes['nestjs.microservice.data']);
    expect(data).toContain('"id":1');
    expect(data).toContain('[REDACTED]');
    expect(data).not.toContain('secret');
  });

  it("captureData: 'never' records nothing on failure", async () => {
    const c = await build({ microservices: { captureData: 'never' } });
    expect(() => c.fail({ a: 1 }, new TcpContext())).toThrow();
    const span = byName('RpcController.fail')!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['nestjs.microservice.data']).toBeUndefined();
  });

  it('maxDataBytes: 8 sets truncated', async () => {
    const c = await build({ microservices: { maxDataBytes: 8 } });
    expect(() => c.fail({ a: 'long value here' }, new TcpContext())).toThrow();
    const span = byName('RpcController.fail')!;
    expect(Buffer.byteLength(String(span.attributes['nestjs.microservice.data']))).toBeLessThanOrEqual(8);
    expect(span.attributes['nestjs.microservice.data.truncated']).toBe(true);
  });
});

const SQS = Symbol.for('SQS_CONSUMER_METHOD');

@Injectable()
class SqsConsumer {
  @SetMetadata(SQS, { name: 'orders' })
  handle(message: { MessageId?: string; Body?: string; MessageAttributes?: unknown }): void {
    if (message.Body?.includes('boom')) throw new Error('fail');
  }

  @SetMetadata(SQS, { name: 'orders', batch: true })
  handleBatch(_messages: unknown[]): void {}
}

describe('@ssut/nestjs-sqs handlers', () => {
  let c: SqsConsumer;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [OtelModule.forRoot()],
      providers: [SqsConsumer],
    }).compile();
    c = moduleRef.get(SqsConsumer);
  });
  beforeEach(() => t.reset());

  const attrsFrom = (span: { spanContext(): unknown }) => {
    const carrier = injectContext({}, trace.setSpan(context.active(), span as never)) as Record<string, string>;
    return { traceparent: { DataType: 'String', StringValue: carrier.traceparent! } };
  };
  const producer = () => {
    const tracer = trace.getTracer('test');
    const p = tracer.startSpan('P');
    const attrs = attrsFrom(p);
    p.end();
    return { p, attrs };
  };

  it('single message: parent comes from MessageAttributes', () => {
    const { p, attrs } = producer();
    c.handle({ MessageId: 'm1', Body: '{"password":"p"}', MessageAttributes: attrs });
    const span = byName('SqsConsumer.handle')!;
    expect(span.kind).toBe(SpanKind.CONSUMER);
    expect(span.spanContext().traceId).toBe(p.spanContext().traceId);
    expect(span.parentSpanContext?.spanId).toBe(p.spanContext().spanId);
    expect(span.attributes).toMatchObject({
      'messaging.system': 'aws_sqs',
      'messaging.destination.name': 'orders',
      'messaging.operation.type': 'process',
      'messaging.message.id': 'm1',
    });
  });

  it('no attributes gives a root', () => {
    c.handle({ MessageId: 'm2', Body: '{}' });
    const span = byName('SqsConsumer.handle')!;
    expect(span.parentSpanContext).toBeUndefined();
  });

  it('no trace attributes gives a root even inside an active span', () => {
    trace.getTracer('test').startActiveSpan('ambient', (amb) => {
      c.handle({ MessageId: 'm5', Body: '{}', MessageAttributes: { other: { DataType: 'String', StringValue: 'x' } } });
      amb.end();
    });
    const span = byName('SqsConsumer.handle')!;
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.spanContext().traceId).not.toBe(byName('ambient')!.spanContext().traceId);
  });

  it('batch: links', () => {
    const a = producer();
    const b = producer();
    c.handleBatch([
      { MessageId: '1', Body: '{}', MessageAttributes: a.attrs },
      { MessageId: '2', Body: '{}' },
      { MessageId: '3', Body: '{}', MessageAttributes: b.attrs },
    ]);
    const span = byName('SqsConsumer.handleBatch')!;
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.links.map((l) => l.context.spanId)).toEqual([a.p.spanContext().spanId, b.p.spanContext().spanId]);
    expect(span.attributes['messaging.batch.message_count']).toBe(3);
  });

  it('failure captures the redacted Body', () => {
    expect(() => c.handle({ MessageId: 'm3', Body: '{"password":"p","boom":1}' })).toThrow('fail');
    let data = String(byName('SqsConsumer.handle')!.attributes['nestjs.microservice.data']);
    expect(data).toContain('[REDACTED]');
    expect(data).not.toContain('"p"');
    t.reset();
    expect(() => c.handle({ MessageId: 'm4', Body: 'plain boom' })).toThrow('fail');
    data = String(byName('SqsConsumer.handle')!.attributes['nestjs.microservice.data']);
    expect(data).toContain('plain boom');
  });

  it('a garbage traceparent in a batch adds no link, even inside an active span', () => {
    const a = producer();
    const bad = { traceparent: { DataType: 'String', StringValue: 'garbage' } };
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('ambient', (amb) => {
      c.handleBatch([
        { MessageId: '1', Body: '{}', MessageAttributes: a.attrs },
        { MessageId: '2', Body: '{}', MessageAttributes: bad },
      ]);
      amb.end();
    });
    const span = byName('SqsConsumer.handleBatch')!;
    expect(span.links.map((l) => l.context.spanId)).toEqual([a.p.spanContext().spanId]);
    expect(span.parentSpanContext).toBeUndefined();
  });

  it('metadata survives wrapping', () => {
    const wrapped = SqsConsumer.prototype.handle;
    expect(Reflect.getMetadata(SQS, wrapped)).toEqual({ name: 'orders' });
    expect(Reflect.getMetadata(SQS, SqsConsumer.prototype.handleBatch)).toEqual({ name: 'orders', batch: true });
  });
});

describe('SQS handler wrapping rules', () => {
  @Injectable()
  class RuleConsumer {
    @SetMetadata(SQS, { name: 'q' })
    marked(_m: unknown): void {}
    unmarked(): void {}
  }
  @Injectable()
  class ExcludedConsumer {
    @SetMetadata(SQS, { name: 'q' })
    marked(_m: unknown): void {}
  }
  @Injectable()
  class NoTraceConsumer {
    @NoTrace()
    @SetMetadata(SQS, { name: 'q' })
    marked(_m: unknown): void {}
  }
  const get = async <T>(cls: new () => T, o: OtelModuleOptions): Promise<T> =>
    (await Test.createTestingModule({ imports: [OtelModule.forRoot(o)], providers: [cls] }).compile()).get(cls);
  beforeEach(() => t.reset());

  it('providers: false still wraps the SQS-marked method only', async () => {
    const c = await get(RuleConsumer, { autoInstrument: { providers: false } });
    c.marked({ MessageId: 'x' });
    c.unmarked();
    expect(byName('RuleConsumer.marked')?.kind).toBe(SpanKind.CONSUMER);
    expect(byName('RuleConsumer.unmarked')).toBeUndefined();
  });

  it('autoInstrument.exclude leaves it unwrapped', async () => {
    const c = await get(ExcludedConsumer, { autoInstrument: { exclude: ['ExcludedConsumer'] } });
    c.marked({ MessageId: 'x' });
    expect(byName('ExcludedConsumer.marked')).toBeUndefined();
  });

  it('@NoTrace() on the method leaves it unwrapped', async () => {
    const c = await get(NoTraceConsumer, {});
    c.marked({ MessageId: 'x' });
    expect(byName('NoTraceConsumer.marked')).toBeUndefined();
  });
});
