import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { type OtlpReceiver, startOtlpReceiver } from '../e2e/helpers/otlp-receiver';
import { spawnApp } from '../e2e/helpers/spawn-app';

const ERROR = 2;
const SECRET = 'hunter2-SECRET';

const urls = inject('dbUrls');

const scenarios = [
  ['typeorm-pg', 'postgres', 'esm'],
  ['typeorm-mysql', 'mysql', 'esm'],
  ['mikro-pg', 'postgres', 'esm'],
  ['mikro-pg', 'postgres', 'cjs'],
  ['mikro-mysql', 'mysql', 'esm'],
  ['mikro-mongo', 'mongo', 'esm'],
] as const;

let receiver: OtlpReceiver;
beforeEach(async () => {
  receiver = await startOtlpReceiver();
});
afterEach(async () => {
  await receiver.close();
});

const isDriverSpan = (s: { attributes: Record<string, unknown> }): boolean =>
  !s.attributes['db.orm.name'] && Boolean(s.attributes['db.system.name'] ?? s.attributes['db.system']);

describe.skipIf(!urls)('databases', () => {
  describe.each(scenarios)('%s via %s (%s)', (db, store, entry) => {
    const start = () =>
      spawnApp({ entry, preload: entry === 'esm', receiver, env: { DB: db, DATABASE_URL: urls![store] } });

    it('trace chain: server → controller → service → ORM → driver', async () => {
      const app = await start();
      expect((await app.get('/db/users/1')).status).toBe(200);
      const svc = await receiver.waitFor(() => receiver.spans().find((s) => s.name === 'UsersDbService.findOne'));
      const orm = await receiver.waitFor(() =>
        receiver.spans().find((s) => s.attributes['db.orm.name'] && s.name.includes('find')),
      );
      expect(orm.name).toBe(db.startsWith('typeorm') ? 'TypeORM findOne User' : 'MikroORM findOne User');
      expect(orm.parentSpanId).toBe(svc.spanId);
      const ctrl = receiver.spans().find((s) => s.name === 'UsersDbController.findOne')!;
      expect(svc.parentSpanId).toBe(ctrl.spanId);
      const driver = receiver.spans().find((s) => s.parentSpanId === orm.spanId && isDriverSpan(s));
      expect(driver).toBeDefined();
    });

    it('secret never leaks on success', async () => {
      const app = await start();
      expect((await app.post('/db/users', { email: 'a@b.c', password: SECRET })).status).toBe(201);
      const orm = await receiver.waitFor(() => receiver.spans().find((s) => s.attributes['db.orm.name']));
      await app.stop();
      expect(orm.status.code).not.toBe(ERROR);
      expect(receiver.spans().some((s) => isDriverSpan(s) && s.traceId === orm.traceId)).toBe(true);
      expect(JSON.stringify(receiver.spans())).not.toContain(SECRET);
    });

    it('failure: ORM span has error and redacted params; secret absent', async () => {
      const app = await start();
      expect((await app.post('/db/users/dup', { id: 1, email: 'd', password: SECRET })).status).toBe(500);
      const orm = await receiver.waitFor(() =>
        receiver.spans().find((s) => s.attributes['db.orm.name'] && s.status.code === ERROR),
      );
      await app.stop();
      expect(orm.attributes['db.operation.name']).toBe('insert');
      // The first insert succeeded: the second failed on the duplicate id.
      const inserts = receiver
        .spans()
        .filter((s) => s.attributes['db.orm.name'] && s.attributes['db.operation.name'] === 'insert');
      expect(inserts.map((s) => s.status.code).sort()).toEqual([0, ERROR]);
      expect(orm.attributes['db.orm.params']).toContain('[REDACTED]');
      expect(JSON.stringify(receiver.spans())).not.toContain(SECRET);
    });
  });

  it('pg driver metrics exported', async () => {
    const app = await spawnApp({
      entry: 'esm',
      preload: true,
      receiver,
      env: { DB: 'typeorm-pg', DATABASE_URL: urls!.postgres },
    });
    expect((await app.get('/db/users/1')).status).toBe(200);
    await receiver.waitFor(
      () =>
        receiver.metricNames().includes('db.client.operation.duration') &&
        receiver.metricNames().includes('db.client.connection.count'),
    );
    await app.stop();
  });
});
