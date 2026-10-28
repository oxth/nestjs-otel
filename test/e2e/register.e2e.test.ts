import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe.each([
  ['esm', true],
  ['cjs', false],
  ['esm-dynamic', false],
  ['cjs', true],
] as const)('bootstrap %s preload=%s', (entry, preload) => {
  it('exports an http server span for a request', async () => {
    const app = await spawnApp({ entry, preload, receiver });
    await app.get('/users/1');
    const s = await receiver.waitFor(() => receiver.spans().find((s) => s.kind === SERVER));
    expect(s.attributes['http.request.method']).toBe('GET');
    await app.stop();
  });
});

it('exports controller and provider spans under the server span', async () => {
  const app = await spawnApp({ entry: 'esm', preload: true, receiver });
  await app.get('/users/1');
  const svc = await receiver.waitFor(() => receiver.spans().find((s) => s.name === 'UsersService.findOne'));
  await app.stop();
  const spans = receiver.spans();
  const ctrl = spans.find((s) => s.name === 'UsersController.findOne')!;
  const server = spans.find((s) => s.kind === SERVER)!;
  expect(svc.parentSpanId).toBe(ctrl.spanId);
  expect(ctrl.attributes['code.namespace']).toBe('UsersController');
  // Walk up from the controller span (express spans may sit in between).
  const ancestors: string[] = [];
  for (let p = ctrl.parentSpanId; p; p = spans.find((s) => s.spanId === p)?.parentSpanId) ancestors.push(p);
  expect(ancestors).toContain(server.spanId);
  expect(new Set([svc.traceId, ctrl.traceId, server.traceId]).size).toBe(1);
});

it('exports metrics and logs over OTLP by default', async () => {
  const app = await spawnApp({ entry: 'esm', preload: true, receiver, env: { LOGGER: 'pino' } });
  await app.get('/users/1');
  await receiver.waitFor(() => receiver.metricNames().some((n) => n.startsWith('nodejs.') || n.startsWith('v8js.')));
  await receiver.waitFor(() => receiver.metricNames().includes('http.server.request.duration'));
  await receiver.waitFor(() => receiver.logs().length > 0);
  await app.stop();
  // OTEL_SERVICE_NAME wins over the fixture's package.json name.
  expect(receiver.resources().length).toBeGreaterThan(0);
  for (const r of receiver.resources()) expect(r['service.name']).toBe('fixture');
});

it('import line plus --import registers once', async () => {
  const app = await spawnApp({ entry: 'cjs', preload: true, receiver });
  await app.get('/users/1');
  await app.stop();
  expect(receiver.spans().filter((s) => s.kind === SERVER)).toHaveLength(1);
});

it('cjs app with --import shares sdk state', async () => {
  // --import loads the ESM register; the app's own require() loads the CJS one. Both must see
  // one global state: the second is a no-op, and neither warns.
  const app = await spawnApp({ entry: 'cjs', preload: true, receiver });
  await app.get('/users/1');
  await app.stop();
  expect(receiver.spans().filter((s) => s.kind === SERVER)).toHaveLength(1);
  expect(app.stderr()).not.toContain('@oxth/nestjs-otel');
});

it('express spans are instrumented in ESM (hook works)', async () => {
  const app = await spawnApp({ entry: 'esm', preload: true, receiver });
  await app.get('/users/1');
  await receiver.waitFor(() => receiver.spans().find((s) => s.attributes['express.type'] !== undefined));
  await app.stop();
});

it('OTEL_SDK_DISABLED produces no telemetry and app still serves', async () => {
  const app = await spawnApp({ entry: 'esm', preload: true, receiver, env: { OTEL_SDK_DISABLED: 'true' } });
  expect((await app.get('/users/1')).status).toBe(200);
  await new Promise((r) => setTimeout(r, 800));
  await app.stop();
  expect(receiver.spans()).toHaveLength(0);
});
