import { createServer } from 'node:net';
import { Controller, type INestApplication, Injectable, SetMetadata } from '@nestjs/common';
import * as ms from '@nestjs/microservices';
import { type ClientProxy, ClientProxyFactory, Ctx, MessagePattern, Payload, Transport } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { type Context, context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { lastValueFrom } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { injectContext, OtelModule } from '../../src/index';
import { patchClients, unpatchClients } from '../../src/microservices/client';
import { patchServers, unpatchServers } from '../../src/microservices/server';
import { setupInMemoryTracing } from './helpers/tracing';
import { X_TRACE, XTracePropagator } from './helpers/x-propagator';

// `OTEL_PROPAGATORS=b3` (or jaeger, ...) installs a global propagator without `traceparent`.
const t = setupInMemoryTracing();
propagation.disable();
propagation.setGlobalPropagator(new XTracePropagator());

const tracer = () => trace.getTracer('test');
const byName = (name: string): ReadableSpan | undefined => t.spans().find((s) => s.name === name);
const parentId = (s: ReadableSpan | undefined) => s?.parentSpanContext?.spanId;

async function waitFor<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

const received: unknown[] = [];

@Controller()
class XController {
  @MessagePattern('x.get')
  get(@Payload() data: unknown, @Ctx() ctx: ms.TcpContext): unknown {
    received.push((ctx as any).getMetadata?.());
    return { data };
  }
}

const SQS = Symbol.for('SQS_CONSUMER_METHOD');

@Injectable()
class XSqsConsumer {
  @SetMetadata(SQS, { name: 'orders' })
  handle(_message: unknown): void {}

  @SetMetadata(SQS, { name: 'orders', batch: true })
  handleBatch(_messages: unknown[]): void {}
}

let app: INestApplication;
let client: ClientProxy;
let sqs: XSqsConsumer;

beforeAll(async () => {
  const port = await freePort();
  const moduleRef = await Test.createTestingModule({
    imports: [OtelModule.forRoot({ autoInstrument: { microservices: false } })],
    controllers: [XController],
    providers: [XSqsConsumer],
  }).compile();
  patchClients(ms);
  patchServers(ms);
  app = moduleRef.createNestApplication({ logger: false });
  app.connectMicroservice({ transport: Transport.TCP, options: { port } }, { inheritAppConfig: true });
  await app.startAllMicroservices();
  await app.init();
  sqs = app.get(XSqsConsumer);
  client = ClientProxyFactory.create({ transport: Transport.TCP, options: { port } }) as ClientProxy;
  await client.connect();
});

afterAll(async () => {
  client?.close();
  await app?.close();
  unpatchClients(ms);
  unpatchServers(ms);
  propagation.disable();
});

beforeEach(() => t.reset());

/** The carrier for `span` under the global (non-W3C) propagator. */
const carrierFor = (span: { spanContext(): unknown }) =>
  injectContext({} as Record<string, string>, trace.setSpan(ROOT_CONTEXT, span as never));

describe('a non-W3C global propagator (OTEL_PROPAGATORS)', () => {
  it('TCP: the carrier uses its fields and the handler continues the trace', async () => {
    received.length = 0;
    await tracer().startActiveSpan('caller', async (caller) => {
      await lastValueFrom(client.send('x.get', { id: 1 }));
      caller.end();
    });
    const send = await waitFor(() => byName('send x.get'));
    const handler = await waitFor(() => byName('XController.get'));
    expect(handler.spanContext().traceId).toBe(send.spanContext().traceId);
    expect(parentId(handler)).toBe(send.spanContext().spanId);
    const md = received[0] as Record<string, unknown> | undefined;
    // Nest 11 doesn't hand metadata to the context; Nest 12 does.
    if (md !== undefined) {
      expect(md[X_TRACE]).toBe(`${send.spanContext().traceId}-${send.spanContext().spanId}`);
      expect(md.traceparent).toBeUndefined();
    }
  });

  describe('Redis: ServerRedis.handleMessage extracts with the global propagator', () => {
    /** Calls the patched method with a fake server whose `parseMessage` records the active context. */
    async function deliver(buffer: Buffer): Promise<Context[]> {
      const seen: Context[] = [];
      const fake = {
        parseMessage: (b: Buffer) => {
          seen.push(context.active());
          return JSON.parse(b.toString());
        },
        // Stops Nest's handleMessage right after it parsed the message.
        deserializer: {
          deserialize: () => {
            throw new Error('stop');
          },
        },
      };
      await (ms.ServerRedis.prototype as any).handleMessage
        .call(fake, 'x.get', buffer, undefined, 'x.get')
        .catch(() => undefined);
      return seen;
    }

    it('a message carrying x-trace runs in the sender context', async () => {
      const p = tracer().startSpan('P');
      p.end();
      const packet = { pattern: 'x.get', data: {}, id: '1', metadata: carrierFor(p) };
      const seen = await deliver(Buffer.from(JSON.stringify(packet)));
      // Once by the library (detection), once by Nest's original, which runs in the extracted context.
      const inOriginal = trace.getSpanContext(seen.at(-1)!);
      expect(inOriginal?.traceId).toBe(p.spanContext().traceId);
      expect(inOriginal?.spanId).toBe(p.spanContext().spanId);
    });

    it('a message without any propagator field is not parsed early', async () => {
      const seen = await deliver(Buffer.from(JSON.stringify({ pattern: 'x.get', data: {}, id: '2' })));
      expect(seen).toHaveLength(1);
      expect(trace.getSpanContext(seen[0]!)).toBeUndefined();
    });
  });

  describe('SQS: MessageAttributes are read by the propagator fields', () => {
    const attrsFor = (span: { spanContext(): unknown }) => ({
      [X_TRACE]: { DataType: 'String', StringValue: carrierFor(span)[X_TRACE]! },
    });

    it('single message: parent from the x-trace attribute', () => {
      const p = tracer().startSpan('P');
      p.end();
      sqs.handle({ MessageId: 'm1', Body: '{}', MessageAttributes: attrsFor(p) });
      const span = byName('XSqsConsumer.handle')!;
      expect(span.spanContext().traceId).toBe(p.spanContext().traceId);
      expect(parentId(span)).toBe(p.spanContext().spanId);
    });

    it('batch: one link per message carrying x-trace', () => {
      const a = tracer().startSpan('A');
      const b = tracer().startSpan('B');
      a.end();
      b.end();
      sqs.handleBatch([
        { MessageId: '1', Body: '{}', MessageAttributes: attrsFor(a) },
        { MessageId: '2', Body: '{}' },
        { MessageId: '3', Body: '{}', MessageAttributes: attrsFor(b) },
      ]);
      const span = byName('XSqsConsumer.handleBatch')!;
      expect(span.links.map((l) => l.context.spanId)).toEqual([a.spanContext().spanId, b.spanContext().spanId]);
    });
  });
});
