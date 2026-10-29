import { type Context, context, ROOT_CONTEXT } from '@opentelemetry/api';
import { type MethodWrapper, patchMethods, unpatchMethods } from '../orm/patch';
import { extractContext } from '../propagation/helpers';
import { safely } from '../shared/safe';

const HANDLE_MESSAGE = ['handleMessage'] as const;

const protoOf = (ms: any, name: string): object | undefined =>
  safely(`microservices ${name}`, () => ms?.[name]?.prototype, undefined);

function metadataOf(message: unknown): Record<string, unknown> | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const md = (message as { metadata?: unknown }).metadata;
  return md !== null && typeof md === 'object' ? (md as Record<string, unknown>) : undefined;
}

/**
 * An incoming message is an entry point: its parent is the carrier in `metadata`, or none (a new
 * root) when the sender didn't propagate.
 */
function incomingContext(message: unknown): Context {
  return safely('extract packet metadata', () => extractContext(metadataOf(message), ROOT_CONTEXT), ROOT_CONTEXT);
}

/** `ServerTCP.handleMessage(socket, rawMessage)`: the JSON socket already delivers an object. */
const tcpWrapper: MethodWrapper = (original) =>
  function (this: any, socket: unknown, rawMessage: unknown, ...rest: unknown[]) {
    const ctx = incomingContext(rawMessage);
    return context.with(ctx, () => original.call(this, socket, rawMessage, ...rest));
  };

function redisMessage(server: any, buffer: unknown): unknown {
  return safely(
    'read redis message',
    () => {
      const text = typeof buffer === 'string' ? buffer : Buffer.isBuffer(buffer) ? buffer.toString() : undefined;
      if (text === undefined || !text.includes('traceparent')) return undefined;
      return typeof server?.parseMessage === 'function' ? server.parseMessage(buffer) : JSON.parse(text);
    },
    undefined,
  );
}

/** `ServerRedis.handleMessage(channel, buffer, pub, pattern)`: parsed only when it carries a context. */
const redisWrapper: MethodWrapper = (original) =>
  function (this: any, channel: unknown, buffer: unknown, ...rest: unknown[]) {
    const ctx = incomingContext(redisMessage(this, buffer));
    return context.with(ctx, () => original.call(this, channel, buffer, ...rest));
  };

export function patchServers(ms: any): void {
  safely(
    'patch microservice servers',
    () => {
      patchMethods(protoOf(ms, 'ServerTCP'), HANDLE_MESSAGE, tcpWrapper);
      patchMethods(protoOf(ms, 'ServerRedis'), HANDLE_MESSAGE, redisWrapper);
    },
    undefined,
  );
}

export function unpatchServers(ms: any): void {
  safely(
    'unpatch microservice servers',
    () => {
      unpatchMethods(protoOf(ms, 'ServerTCP'), HANDLE_MESSAGE);
      unpatchMethods(protoOf(ms, 'ServerRedis'), HANDLE_MESSAGE);
    },
    undefined,
  );
}
