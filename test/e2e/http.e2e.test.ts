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

describe.each(['express', 'fastify'])('%s', (adapter) => {
  it('route-template span name and exception on innermost span', async () => {
    const app = await spawnApp({ entry: 'esm', preload: true, receiver, env: { ADAPTER: adapter } });
    expect((await app.get('/users/500')).status).toBe(500);
    await app.stop();
    const server = await receiver.waitFor(() => receiver.spans().find((s) => s.kind === SERVER));
    expect(server.name).toBe('GET /users/:id');
    expect(server.attributes['http.route']).toBe('/users/:id');
    expect(server.status.code).toBe(2);
    const svc = receiver.spans().find((s) => s.name === 'UsersService.findOne')!;
    const ev = svc.events.find((e) => e.name === 'exception')!;
    expect(ev.attributes['exception.stacktrace']).toContain('db exploded');
    expect(ev.attributes['exception.stacktrace']).toContain('Caused by: Error: conn reset');
    expect(svc.traceId).toBe(server.traceId);
    expect(receiver.spans().flatMap((s) => s.events).filter((e) => e.name === 'exception')).toHaveLength(1);
  });

  it('guard error recorded on server span', async () => {
    const app = await spawnApp({ entry: 'esm', preload: true, receiver, env: { ADAPTER: adapter } });
    expect((await app.get('/guarded')).status).toBe(500);
    await app.stop();
    const server = await receiver.waitFor(() => receiver.spans().find((s) => s.kind === SERVER));
    expect(server.status.code).toBe(2);
    const ev = server.events.find((e) => e.name === 'exception')!;
    expect(ev.attributes['exception.message']).toBe('guard broke');
  });

  it('5xx POST carries redacted request body on server span', async () => {
    const app = await spawnApp({ entry: 'esm', preload: true, receiver, env: { ADAPTER: adapter } });
    const res = await app.get('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'fail', password: 'p' }),
    });
    expect(res.status).toBe(500);
    await app.stop();
    const server = await receiver.waitFor(() => receiver.spans().find((s) => s.kind === SERVER));
    expect(server.name).toBe('POST /users');
    expect(JSON.parse(server.attributes['http.request.body'] as string)).toEqual({
      name: 'fail',
      password: '[REDACTED]',
    });
  });

  it('http.server.request.duration has http.route', async () => {
    const app = await spawnApp({ entry: 'esm', preload: true, receiver, env: { ADAPTER: adapter } });
    expect((await app.get('/users/1')).status).toBe(200);
    await receiver.waitFor(() =>
      receiver.metricPoints('http.server.request.duration').some((p) => p.attributes['http.route'] === '/users/:id'),
    );
    await app.stop();
  });
});

it('redacts credential query parameters on the server span', async () => {
  const app = await spawnApp({ entry: 'esm', preload: true, receiver });
  expect((await app.get('/users/1?access_token=abc&password=p&ok=1')).status).toBe(200);
  await app.stop();
  const server = await receiver.waitFor(() => receiver.spans().find((s) => s.kind === SERVER));
  expect(server.attributes['url.query']).toBe('access_token=REDACTED&password=REDACTED&ok=1');
});
