import { logs, metrics, trace } from '@opentelemetry/api';
import { setGlobalErrorHandler } from '@opentelemetry/core';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK, type NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { getGlobalState, type SdkHandle } from '../shared/global-state';
import { safely } from '../shared/safe';
import type { BootstrapConfig } from './config';
import { buildInstrumentations } from './instrumentations';
import { buildResourceAttributes } from './resource';

export type SpanProcessor = NonNullable<NodeSDKConfiguration['spanProcessors']>[number];
export type MetricReader = NonNullable<NodeSDKConfiguration['metricReaders']>[number];
export type LogRecordProcessor = NonNullable<NodeSDKConfiguration['logRecordProcessors']>[number];

export interface SdkOverrides {
  spanProcessors?: SpanProcessor[];
  metricReaders?: MetricReader[];
  logRecordProcessors?: LogRecordProcessor[];
}

const SHUTDOWN_TIMEOUT_MS = 5000;
const ERROR_INTERVAL_MS = 60_000;
const ERROR_PREFIX_LENGTH = 80;
const SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

export function getSdkHandle(): SdkHandle | undefined {
  return getGlobalState().sdk;
}

export function startSdk(cfg: BootstrapConfig, overrides: SdkOverrides = {}): SdkHandle | undefined {
  if (cfg.disabled) return undefined;
  const state = getGlobalState();
  if (state.sdk) return state.sdk;

  return safely<SdkHandle | undefined>(
    'start sdk',
    () => {
      installErrorHandler();
      const sdk = new NodeSDK({
        resource: defaultResource().merge(resourceFromAttributes(buildResourceAttributes(process.env, process.cwd()))),
        instrumentations: buildInstrumentations(cfg),
        ...overrides,
      });
      sdk.start();
      const handle = createHandle(sdk);
      state.sdk = handle;
      installShutdown(handle);
      return handle;
    },
    undefined,
  );
}

function createHandle(sdk: NodeSDK): SdkHandle {
  let shutdownPromise: Promise<void> | undefined;
  return {
    shutdown() {
      shutdownPromise ??= sdk.shutdown().catch((err: unknown) => {
        safely('sdk shutdown', () => reportExportError(err), undefined);
      });
      return shutdownPromise;
    },
    async forceFlush() {
      const providers: unknown[] = [trace.getTracerProvider(), metrics.getMeterProvider(), logs.getLoggerProvider()];
      await Promise.all(
        providers.map(async (provider) => {
          try {
            const p = provider as { getDelegate?: () => unknown };
            const target = (typeof p.getDelegate === 'function' ? p.getDelegate() : p) as {
              forceFlush?: () => Promise<void>;
            };
            if (typeof target?.forceFlush === 'function') await target.forceFlush();
          } catch (err) {
            safely('sdk forceFlush', () => reportExportError(err), undefined);
          }
        }),
      );
    },
  };
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function installShutdown(handle: SdkHandle): void {
  for (const signal of SIGNALS) {
    const onSignal = (): void => {
      // Someone else (e.g. Nest's enableShutdownHooks) owns shutdown: don't cut the SDK off while
      // the app is still draining. OtelModule.onApplicationShutdown shuts it down after Nest's
      // hooks; staying armed also covers apps without OtelModule when Nest re-raises the signal.
      if (process.listenerCount(signal) > 0) {
        process.once(signal, onSignal);
        return;
      }
      void withTimeout(
        Promise.resolve().then(() => handle.shutdown()),
        SHUTDOWN_TIMEOUT_MS,
      ).then(() => {
        if (process.listenerCount(signal) > 0) return;
        process.kill(process.pid, signal);
      });
    };
    process.once(signal, onSignal);
  }
}

const errorLog = new Map<string, { last: number; suppressed: number }>();

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

function reportExportError(err: unknown): void {
  const message = errorMessage(err);
  const prefix = message.slice(0, ERROR_PREFIX_LENGTH);
  const now = Date.now();
  const entry = errorLog.get(prefix);
  if (entry && now - entry.last < ERROR_INTERVAL_MS) {
    entry.suppressed++;
    return;
  }
  const suppressed = entry?.suppressed ?? 0;
  errorLog.set(prefix, { last: now, suppressed: 0 });
  const suffix = suppressed > 0 ? ` (${suppressed} similar errors suppressed)` : '';
  process.stderr.write(`@oxth/nestjs-otel: telemetry export error: ${message}${suffix}\n`);
}

function installErrorHandler(): void {
  setGlobalErrorHandler((err) => {
    safely('telemetry error handler', () => reportExportError(err), undefined);
  });
}
