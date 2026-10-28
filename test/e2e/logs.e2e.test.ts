import { afterEach, beforeEach, expect, it } from 'vitest';
import { type OtlpReceiver, startOtlpReceiver } from './helpers/otlp-receiver';
import { spawnApp } from './helpers/spawn-app';

const SERVER = 2;

let receiver: OtlpReceiver;
beforeEach(async () => {
  receiver = await startOtlpReceiver();
});
afterEach(async () => {
  await receiver.close();
});

it.each(['nest', 'pino'])('%s logger: request logs carry trace ids matching the server span', async (logger) => {
  const app = await spawnApp({ entry: 'esm', preload: true, receiver, env: { LOGGER: logger } });
  expect((await app.get('/users/1')).status).toBe(200);
  await app.stop();
  const server = await receiver.waitFor(() => receiver.spans().find((s) => s.kind === SERVER));
  const log = await receiver.waitFor(() => receiver.logs().find((l) => JSON.stringify(l.body).includes('fetching user')));
  expect(log.traceId).toBe(server.traceId);
  expect(app.stdout()).toMatch(logger === 'pino' ? /"trace_id":"[0-9a-f]{32}"/ : /trace_id=[0-9a-f]{32}/);
});

it('500 via nest logger produces exactly one exception event in the trace', async () => {
  const app = await spawnApp({ entry: 'esm', preload: true, receiver, env: { LOGGER: 'nest' } });
  expect((await app.get('/users/500')).status).toBe(500);
  await app.stop();
  const server = await receiver.waitFor(() => receiver.spans().find((s) => s.kind === SERVER));
  // The ExceptionsHandler error log went through OtelLogger (and over OTLP) ...
  await receiver.waitFor(() =>
    receiver.logs().find((l) => l.severityNumber === 17 && JSON.stringify(l.body).includes('db exploded')),
  );
  // ... without adding a second exception event for the error the wrappers already recorded.
  const events = receiver
    .spans()
    .filter((s) => s.traceId === server.traceId)
    .flatMap((s) => s.events)
    .filter((e) => e.name === 'exception');
  expect(events).toHaveLength(1);
  expect(events[0].attributes['exception.stacktrace']).toContain('Caused by: Error: conn reset');
});
