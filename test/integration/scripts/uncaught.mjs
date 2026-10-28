// In-process synchronous processors print records to stdout, because the OTLP
// batch flush cannot finish once Node starts crashing (see task report).
import { context, logs, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { installProcessErrorMonitor } from '../.tmp/bootstrap/index.mjs';

const mode = process.argv[2];
const emit = (kind, data) => console.log(`${kind} ${JSON.stringify(data)}`);

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    spanProcessors: [
      {
        onStart() {},
        onEnd: (s) => emit('SPAN', { name: s.name, status: s.status.code, events: s.events.map((e) => e.name) }),
        forceFlush: async () => {},
        shutdown: async () => {},
      },
    ],
  }),
);
logs.setGlobalLoggerProvider(
  new LoggerProvider({
    processors: [
      {
        onEmit: (r) => emit('LOG', { severityNumber: r.severityNumber, body: r.body, attributes: r.attributes }),
        forceFlush: async () => {},
        shutdown: async () => {},
      },
    ],
  }),
);

installProcessErrorMonitor();
installProcessErrorMonitor();
emit('LISTENERS', {
  uncaught: process.listenerCount('uncaughtException'),
  rejection: process.listenerCount('unhandledRejection'),
  monitor: process.listenerCount('uncaughtExceptionMonitor'),
});
if (mode === 'listeners') process.exit(0);
setTimeout(() => {
  if (mode === 'rejection') Promise.reject(new Error('rejected'));
  else if (mode === 'span') {
    // The sync throw would unwind the context before the monitor runs; a throw from an
    // async callback created inside the span keeps the span active (realistic for handlers).
    trace.getTracer('t').startActiveSpan('doomed', () => {
      setTimeout(() => {
        throw new Error('kaboom');
      }, 10);
    });
  } else throw new Error('kaboom');
}, 50);
