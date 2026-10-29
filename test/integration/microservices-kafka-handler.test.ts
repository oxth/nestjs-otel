import * as ms from '@nestjs/microservices';
import { context } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RPC_CONTEXT_KEY } from '../../src/microservices/pattern';
import { patchServers, unpatchServers } from '../../src/microservices/server';
import { setupInMemoryTracing } from './helpers/tracing';

setupInMemoryTracing();

// Nest 12's ServerKafka overrides addHandler and keeps RegExp patterns away from Server.addHandler.
const ownKafkaAddHandler = Object.hasOwn(ms.ServerKafka.prototype, 'addHandler');

/** A ServerKafka without a broker: only the handler map that addHandler writes. */
function fakeKafkaServer(): any {
  const server = Object.create(ms.ServerKafka.prototype);
  server.messageHandlers = new Map();
  return server;
}

/** Registers `pattern`, runs the stored handler with a real KafkaContext, returns the RPC context it saw. */
function rpcContextSeen(pattern: string | RegExp): { seen: unknown; ctx: unknown } {
  const server = fakeKafkaServer();
  let seen: unknown;
  server.addHandler(pattern, () => {
    seen = context.active().getValue(RPC_CONTEXT_KEY);
  }, true);
  const handler = server.messageHandlers.get(pattern instanceof RegExp ? pattern : server.normalizePattern(pattern));
  expect(handler?.isEventHandler).toBe(true);
  const ctx = new ms.KafkaContext([{}, 0, 'orders.created', undefined as never, undefined as never] as never);
  handler({ id: 1 }, ctx);
  return { seen, ctx };
}

describe('ServerKafka.addHandler', () => {
  beforeAll(() => patchServers(ms));
  afterAll(() => unpatchServers(ms));

  it.runIf(ownKafkaAddHandler)('a RegExp handler gets the RPC context', () => {
    const { seen, ctx } = rpcContextSeen(/orders\..*/);
    expect(seen).toBe(ctx);
  });

  it('a string handler gets the RPC context', () => {
    const { seen, ctx } = rpcContextSeen('orders.created');
    expect(seen).toBe(ctx);
  });

  it.runIf(ownKafkaAddHandler)('unpatch restores the own method', () => {
    unpatchServers(ms);
    try {
      const { seen } = rpcContextSeen(/orders\..*/);
      expect(seen).toBeUndefined();
    } finally {
      patchServers(ms);
    }
  });
});
