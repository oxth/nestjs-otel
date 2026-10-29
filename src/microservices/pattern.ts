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

/** String patterns as-is, otherwise JSON with keys sorted recursively. Never throws. */
export function patternToString(p: unknown): string {
  if (typeof p === 'string') return p;
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

function ctorName(o: unknown): string | undefined {
  return safely('ctorName', () => (o as { constructor?: { name?: string } } | null)?.constructor?.name, undefined);
}

export function systemOfClient(client: object): string {
  const n = ctorName(client);
  return (n !== undefined && Object.hasOwn(CLIENTS, n) ? CLIENTS[n] : undefined) ?? 'nestjs';
}

export function systemOfContext(ctx: unknown): string | undefined {
  const n = ctorName(ctx);
  return n !== undefined && Object.hasOwn(CONTEXTS, n) ? CONTEXTS[n] : undefined;
}
