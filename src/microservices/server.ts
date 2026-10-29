import { type Context, context, ROOT_CONTEXT } from '@opentelemetry/api';
import { isObservable, Observable } from 'rxjs';
import { type MethodWrapper, patchMethods, unpatchMethods } from '../orm/patch';
import { extractContext } from '../propagation/helpers';
import { safely } from '../shared/safe';
import { findRpcContext, RPC_CONTEXT_KEY } from './pattern';

const HANDLE_MESSAGE = ['handleMessage'] as const;
const ADD_HANDLER = ['addHandler'] as const;

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

/**
 * Runs a registered handler with its RPC context in `RPC_CONTEXT_KEY`, so handler spans can read the
 * transport even when Nest passes the method only the payload (no `@Ctx()`). A Proxy keeps every
 * property Nest and the transports read or write on the handler (`isEventHandler`, `extras`, and
 * `next`, which Nest's event closures read from themselves to chain handlers) on the original.
 */
function withRpcContext(callback: (...a: any[]) => any): (...a: any[]) => any {
  return new Proxy(callback, {
    apply(target, thisArg, args: unknown[]) {
      const ctx = safely(
        'set rpc context',
        () => {
          const rpc = findRpcContext(args);
          return rpc === undefined ? undefined : context.active().setValue(RPC_CONTEXT_KEY, rpc);
        },
        undefined,
      );
      if (!ctx) return Reflect.apply(target, thisArg, args);
      return bindResult(
        context.with(ctx, () => Reflect.apply(target, thisArg, args)),
        ctx,
      );
    },
  });
}

/**
 * With interceptors, Nest's handler resolves to a lazy Observable that the server subscribes to after
 * the call returns, outside `context.with`; the interceptor chain and the method run on that
 * subscription. Subscribe it in the RPC context too. Values, errors and teardown pass through.
 */
function bindResult(result: unknown, ctx: Context): unknown {
  const bind = (value: unknown): unknown =>
    safely(
      'bind rpc observable',
      () =>
        isObservable(value)
          ? new Observable((subscriber) => context.with(ctx, () => value.subscribe(subscriber)))
          : value,
      value,
    );
  if (result instanceof Promise) {
    return safely('bind rpc result', () => result.then(bind), result);
  }
  return bind(result);
}

/** `Server.addHandler(pattern, callback, isEventHandler?, extras?)` (Nest 11 and 12; gRPC overrides it). */
const addHandlerWrapper: MethodWrapper = (original) =>
  function (this: any, pattern: unknown, callback: unknown, ...rest: unknown[]) {
    const handler =
      typeof callback === 'function'
        ? safely('wrap rpc handler', () => withRpcContext(callback as (...a: any[]) => any), callback)
        : callback;
    return original.call(this, pattern, handler, ...rest);
  };

export function patchServers(ms: any): void {
  safely(
    'patch microservice servers',
    () => {
      patchMethods(protoOf(ms, 'ServerTCP'), HANDLE_MESSAGE, tcpWrapper);
      patchMethods(protoOf(ms, 'ServerRedis'), HANDLE_MESSAGE, redisWrapper);
      patchMethods(protoOf(ms, 'Server'), ADD_HANDLER, addHandlerWrapper);
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
      unpatchMethods(protoOf(ms, 'Server'), ADD_HANDLER);
    },
    undefined,
  );
}
