import { createServer } from 'node:net';
import { Controller, type INestApplication } from '@nestjs/common';
import * as ms from '@nestjs/microservices';
import {
  ClientProxy,
  ClientProxyFactory,
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
  RpcException,
  type TcpContext,
  Transport,
} from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { lastValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OtelModule } from '../../src/index';
import {
  instrumentMicroservices,
  resetMicroservicesPatchStateForTests,
} from '../../src/microservices/install';
import { patchClients, unpatchClients } from '../../src/microservices/client';
import { patchServers, unpatchServers } from '../../src/microservices/server';
import { resolveOptions } from '../../src/module/options';
import { setupInMemoryTracing } from './helpers/tracing';

const t = setupInMemoryTracing();
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const received: { data?: unknown; metadata?: unknown }[] = [];
let eventSeen: (() => void) | undefined;
const dupSeen: string[] = [];
let dupDone: (() => void) | undefined;
let e2Seen: (() => void) | undefined;

@Controller()
class UsersController {
  @MessagePattern('users.get')
  get(@Payload() data: unknown, @Ctx() ctx: TcpContext): unknown {
    received.push({ data, metadata: (ctx as any).getMetadata?.() });
    return { ok: true, data };
  }

  @MessagePattern('users.fail')
  fail(): never {
    throw new RpcException('nope');
  }

  @EventPattern('user.created')
  created(@Payload() data: unknown): void {
    received.push({ data });
    eventSeen?.();
  }

  // No param decorators: Nest passes only the payload.
  @EventPattern('e2')
  handle(data: unknown): void {
    received.push({ data });
    e2Seen?.();
  }

  @MessagePattern('m2')
  m2(@Payload() data: unknown): unknown {
    return { m2: data };
  }

  @EventPattern('dup')
  dupA(_data: unknown): void {
    dupSeen.push('a');
    if (dupSeen.length === 2) dupDone?.();
  }

  @EventPattern('dup')
  dupB(_data: unknown): void {
    dupSeen.push('b');
    if (dupSeen.length === 2) dupDone?.();
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

let app: INestApplication;
let port: number;
let client: ClientProxy;

function newClient(): ClientProxy {
  return ClientProxyFactory.create({ transport: Transport.TCP, options: { port } }) as ClientProxy;
}

beforeAll(async () => {
  port = await freePort();
  const moduleRef = await Test.createTestingModule({
    imports: [OtelModule.forRoot({ autoInstrument: { microservices: false } })],
    controllers: [UsersController],
  }).compile();
  // Patched before `connectMicroservice`, which registers the handlers (`Server.addHandler`) right away;
  // in an app, `OtelModule` patches during `NestFactory.create`, earlier still.
  patchClients(ms);
  patchServers(ms);
  app = moduleRef.createNestApplication({ logger: false });
  app.connectMicroservice({ transport: Transport.TCP, options: { port } }, { inheritAppConfig: true });
  await app.startAllMicroservices();
  await app.init();
  client = newClient();
  await client.connect();
});

afterAll(async () => {
  client?.close();
  await app?.close();
  unpatchClients(ms);
  unpatchServers(ms);
});

describe('microservices over TCP', () => {
  it('send: client span parents the server side', async () => {
    await tracer().startActiveSpan('caller', async (caller) => {
      await lastValueFrom(client.send('users.get', { id: 1 }));
      caller.end();
    });
    const caller = byName('caller')!;
    const send = await waitFor(() => byName('send users.get'));
    expect(send.kind).toBe(SpanKind.CLIENT);
    expect(parentId(send)).toBe(caller.spanContext().spanId);
    expect(send.spanContext().traceId).toBe(caller.spanContext().traceId);
    expect(send.attributes).toMatchObject({
      'messaging.system': 'tcp',
      'messaging.destination.name': 'users.get',
      'messaging.operation.type': 'send',
      'nestjs.microservice.kind': 'message',
    });
    const handler = await waitFor(() => byName('UsersController.get'));
    expect(handler.spanContext().traceId).toBe(send.spanContext().traceId);
    expect(parentId(handler)).toBe(send.spanContext().spanId);
  });

  it('handler span is SERVER with messaging attributes over real TCP', async () => {
    await lastValueFrom(client.send('users.get', { id: 8 }));
    const handler = await waitFor(() => byName('UsersController.get'));
    expect(handler.kind).toBe(SpanKind.SERVER);
    expect(handler.attributes).toMatchObject({
      'messaging.system': 'tcp',
      'messaging.destination.name': 'users.get',
      'messaging.operation.type': 'process',
      'nestjs.microservice.kind': 'message',
      'nestjs.microservice.pattern': 'users.get',
    });
    expect(handler.attributes['nestjs.microservice.data']).toBeUndefined();

    const seen = new Promise<void>((r) => (eventSeen = r));
    await lastValueFrom(client.emit('user.created', { id: 9 }));
    await seen;
    const event = await waitFor(() => byName('UsersController.created'));
    expect(event.kind).toBe(SpanKind.CONSUMER);
    expect(event.attributes).toMatchObject({
      'messaging.system': 'tcp',
      'messaging.destination.name': 'user.created',
      'nestjs.microservice.kind': 'event',
    });

    await expect(lastValueFrom(client.send('users.fail', { password: 'p' }))).rejects.toBeDefined();
    const failed = await waitFor(() => byName('UsersController.fail'));
    expect(failed.kind).toBe(SpanKind.SERVER);
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.attributes['messaging.system']).toBe('tcp');
    const data = String(failed.attributes['nestjs.microservice.data']);
    expect(data).toContain('[REDACTED]');
    expect(data).not.toContain('"p"');
  });

  it('handlers without @Ctx() get the transport context', async () => {
    const seen = new Promise<void>((r) => (e2Seen = r));
    await lastValueFrom(client.emit('e2', { id: 10 }));
    await seen;
    const e2 = await waitFor(() => byName('UsersController.handle'));
    expect(e2.kind).toBe(SpanKind.CONSUMER);
    expect(e2.attributes).toMatchObject({
      'messaging.system': 'tcp',
      'messaging.destination.name': 'e2',
      'nestjs.microservice.kind': 'event',
    });

    expect(await lastValueFrom(client.send('m2', { id: 11 }))).toEqual({ m2: { id: 11 } });
    const m2 = await waitFor(() => byName('UsersController.m2'));
    expect(m2.kind).toBe(SpanKind.SERVER);
    expect(m2.attributes).toMatchObject({
      'messaging.system': 'tcp',
      'messaging.destination.name': 'm2',
      'nestjs.microservice.kind': 'message',
    });
  });

  it('several event handlers for one pattern all run', async () => {
    dupSeen.length = 0;
    const done = new Promise<void>((r) => (dupDone = r));
    await lastValueFrom(client.emit('dup', { id: 12 }));
    await done;
    expect([...dupSeen].sort()).toEqual(['a', 'b']);
    const a = await waitFor(() => byName('UsersController.dupA'));
    const b = await waitFor(() => byName('UsersController.dupB'));
    for (const s of [a, b]) {
      expect(s.attributes).toMatchObject({ 'messaging.system': 'tcp', 'messaging.destination.name': 'dup' });
    }
  });

  it('emit: producer span', async () => {
    const seen = new Promise<void>((r) => (eventSeen = r));
    await tracer().startActiveSpan('caller', async (caller) => {
      await lastValueFrom(client.emit('user.created', { id: 2 }));
      caller.end();
    });
    await seen;
    const caller = byName('caller')!;
    const emit = await waitFor(() => byName('emit user.created'));
    expect(emit.kind).toBe(SpanKind.PRODUCER);
    expect(parentId(emit)).toBe(caller.spanContext().spanId);
    expect(emit.attributes).toMatchObject({
      'messaging.system': 'tcp',
      'messaging.destination.name': 'user.created',
      'messaging.operation.type': 'send',
      'nestjs.microservice.kind': 'event',
    });
    const handler = await waitFor(() => byName('UsersController.created'));
    expect(parentId(handler)).toBe(emit.spanContext().spanId);
  });

  it('context captured at send() time', async () => {
    let obs!: ReturnType<ClientProxy['send']>;
    tracer().startActiveSpan('caller', (caller) => {
      obs = client.send('users.get', { id: 3 });
      caller.end();
    });
    await context.with(context.active(), async () => {
      expect(trace.getActiveSpan()).toBeUndefined();
      await new Promise((r) => setTimeout(r, 10));
      await lastValueFrom(obs);
    });
    const caller = byName('caller')!;
    const send = await waitFor(() => byName('send users.get'));
    expect(parentId(send)).toBe(caller.spanContext().spanId);
  });

  it('server error is recorded on the client span', async () => {
    await expect(lastValueFrom(client.send('users.fail', { id: 4 }))).rejects.toMatchObject({
      status: 'error',
      message: 'nope',
    });
    const send = await waitFor(() => byName('send users.fail'));
    expect(send.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('unpatched server receives data unchanged', async () => {
    unpatchServers(ms);
    try {
      received.length = 0;
      const data = { id: 1, nested: { a: [1] } };
      const reply = await lastValueFrom(client.send('users.get', data));
      expect(reply).toEqual({ ok: true, data });
      expect(received[0]?.data).toEqual(data);
    } finally {
      patchServers(ms);
    }
  });

  it('unpatched client → patched server', async () => {
    unpatchClients(ms);
    const plain = newClient();
    try {
      await tracer().startActiveSpan('caller', async (caller) => {
        const reply = await lastValueFrom(plain.send('users.get', { id: 5 }));
        expect(reply).toEqual({ ok: true, data: { id: 5 } });
        caller.end();
      });
      const handler = await waitFor(() => byName('UsersController.get'));
      expect(handler.parentSpanContext).toBeUndefined();
      expect(handler.status.code).not.toBe(SpanStatusCode.ERROR);
      expect(byName('send users.get')).toBeUndefined();
    } finally {
      plain.close();
      patchClients(ms);
    }
  });

  const hasHook = typeof (ClientProxy.prototype as any).setOnDispatchHook === 'function';

  it.runIf(hasHook)('existing metadata is preserved', async () => {
    const hooked = newClient();
    (hooked as any).setOnDispatchHook((p: any) => {
      p.metadata = { tenant: 't1' };
    });
    try {
      received.length = 0;
      await lastValueFrom(hooked.send('users.get', { id: 6 }));
      const md = received[0]?.metadata as Record<string, unknown>;
      expect(md).toMatchObject({ tenant: 't1' });
      expect(md.traceparent).toEqual(expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/));
    } finally {
      hooked.close();
    }
  });

  it.runIf(hasHook)('non-object metadata is left alone', async () => {
    const hooked = newClient();
    (hooked as any).setOnDispatchHook((p: any) => {
      p.metadata = 'x';
    });
    try {
      received.length = 0;
      const reply = await lastValueFrom(hooked.send('users.get', { id: 7 }));
      expect(reply).toEqual({ ok: true, data: { id: 7 } });
      expect(received[0]?.metadata).toBe('x');
    } finally {
      hooked.close();
    }
  });

  it('autoInstrument.microservices: false patches nothing', async () => {
    unpatchClients(ms);
    unpatchServers(ms);
    resetMicroservicesPatchStateForTests();
    try {
      const send = ClientProxy.prototype.send;
      const handle = ms.ServerTCP.prototype.handleMessage;
      await instrumentMicroservices(resolveOptions({ autoInstrument: { microservices: false } }));
      expect(ClientProxy.prototype.send).toBe(send);
      expect(ms.ServerTCP.prototype.handleMessage).toBe(handle);
    } finally {
      resetMicroservicesPatchStateForTests();
      patchClients(ms);
      patchServers(ms);
    }
  });

  it('instrumentMicroservices patches once by default', async () => {
    unpatchClients(ms);
    unpatchServers(ms);
    resetMicroservicesPatchStateForTests();
    try {
      const send = ClientProxy.prototype.send;
      const handle = ms.ServerTCP.prototype.handleMessage;
      await instrumentMicroservices(resolveOptions());
      const patched = ClientProxy.prototype.send;
      expect(patched).not.toBe(send);
      expect(ms.ServerTCP.prototype.handleMessage).not.toBe(handle);
      unpatchClients(ms);
      await instrumentMicroservices(resolveOptions());
      expect(ClientProxy.prototype.send).toBe(send);
    } finally {
      unpatchClients(ms);
      unpatchServers(ms);
      resetMicroservicesPatchStateForTests();
      patchClients(ms);
      patchServers(ms);
    }
  });
});
