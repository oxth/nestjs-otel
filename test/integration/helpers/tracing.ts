import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { beforeEach } from 'vitest';

export interface InMemoryTracing {
  exporter: InMemorySpanExporter;
  spans(): ReadableSpan[];
  reset(): void;
  shutdown(): Promise<void>;
}

let current: InMemoryTracing | undefined;

function create(): InMemoryTracing {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  // Clear globals left behind by anything else in this worker, then register ours.
  trace.disable();
  context.disable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);

  const tracing: InMemoryTracing = {
    exporter,
    spans: () => exporter.getFinishedSpans(),
    reset: () => exporter.reset(),
    async shutdown() {
      if (current === tracing) current = undefined;
      await provider.shutdown();
      trace.disable();
      context.disable();
    },
  };
  return tracing;
}

/**
 * Registers a global in-memory tracer provider and async-hooks context manager
 * (once per module instance) and clears recorded spans before every test.
 */
export function setupInMemoryTracing(): InMemoryTracing {
  current ??= create();
  const tracing = current;
  beforeEach(() => tracing.reset());
  return tracing;
}
