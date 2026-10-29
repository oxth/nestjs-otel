import { createContextKey } from '@opentelemetry/api';
import { safely } from '../shared/safe';

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}

/**
 * String patterns as-is, a RegExp as its literal (`String(re)`), otherwise JSON with keys sorted
 * recursively. Never throws.
 */
export function patternToString(p: unknown): string {
  if (typeof p === 'string') return p;
  if (p instanceof RegExp) return safeString(p);
  return safely('patternToString', () => JSON.stringify(sortKeys(p)) ?? String(p), safeString(p));
}

function safeString(p: unknown): string {
  try {
    return String(p);
  } catch {
    return '[object Object]';
  }
}

const CLIENTS: Record<string, string> = {
  ClientTCP: 'tcp',
  ClientRedis: 'redis',
  ClientKafka: 'kafka',
  ClientRMQ: 'rabbitmq',
  ClientNats: 'nats',
  ClientMqtt: 'mqtt',
  ClientGrpcProxy: 'grpc',
};

const CONTEXTS: Record<string, string> = {
  TcpContext: 'tcp',
  RedisContext: 'redis',
  KafkaContext: 'kafka',
  RmqContext: 'rabbitmq',
  NatsContext: 'nats',
  MqttContext: 'mqtt',
};

/** Bounds the prototype walk (a subclass chain is never this deep in practice). */
const MAX_DEPTH = 16;

/**
 * The system of the first class in `o`'s prototype chain whose name is in `table`, so a subclass
 * (`class MyKafka extends ClientKafka`) maps like its base. Never throws.
 */
function systemOf(o: unknown, table: Record<string, string>): string | undefined {
  return safely(
    'systemOf',
    () => {
      if (o === null || typeof o !== 'object') return undefined;
      let proto: unknown = Object.getPrototypeOf(o);
      for (let i = 0; i < MAX_DEPTH && proto !== null && proto !== Object.prototype; i++) {
        const name = (proto as { constructor?: { name?: unknown } }).constructor?.name;
        if (typeof name === 'string' && Object.hasOwn(table, name)) return table[name];
        proto = Object.getPrototypeOf(proto);
      }
      return undefined;
    },
    undefined,
  );
}

export function systemOfClient(client: object): string {
  return systemOf(client, CLIENTS) ?? 'nestjs';
}

export function systemOfContext(ctx: unknown): string | undefined {
  return systemOf(ctx, CONTEXTS);
}

/** The RPC context of the message being handled, set by the `Server.addHandler` patch. */
export const RPC_CONTEXT_KEY = createContextKey('@oxth/nestjs-otel.rpc-context');

/** The last argument whose class is a known transport context. */
export function findRpcContext(args: readonly unknown[]): unknown {
  for (let i = args.length - 1; i >= 0; i--) {
    if (systemOfContext(args[i]) !== undefined) return args[i];
  }
  return undefined;
}
