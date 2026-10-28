import { SpanStatusCode } from '@opentelemetry/api';
import * as core from '@mikro-orm/core';
import { EntitySchema } from '@mikro-orm/core';
import * as sql from '@mikro-orm/sql';
import { MikroORM, SqliteDriver, type SqlEntityManager } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  patchMikroOrm,
  patchMikroQueryBuilder,
  unpatchMikroOrm,
  unpatchMikroQueryBuilder,
} from '../../src/orm/mikro-orm';
import { setupInMemoryTracing } from './helpers/tracing';

const ORIGINAL = Symbol.for('@oxth/nestjs-otel.orm-original');
const originalOf = (fn: unknown) => (fn as Record<symbol, unknown> | undefined)?.[ORIGINAL];

interface User {
  id: number;
  email: string;
  password: string;
}

const UserSchema = new EntitySchema<User>({
  name: 'User',
  tableName: 'users',
  properties: {
    id: { type: 'number', primary: true },
    email: { type: 'string' },
    password: { type: 'string' },
  },
});

const t = setupInMemoryTracing();
let orm: MikroORM;
let em: SqlEntityManager;

const ormSpans = () => t.spans().filter((s) => s.attributes['db.orm.name'] === 'mikro-orm');
const only = (name: string) => {
  const matches = t.spans().filter((s) => s.name === name);
  expect(matches.map((s) => s.name)).toEqual([name]);
  return matches[0];
};

beforeAll(async () => {
  patchMikroOrm(core);
  patchMikroQueryBuilder(sql);
  orm = await MikroORM.init({ driver: SqliteDriver, dbName: ':memory:', entities: [UserSchema] });
  await orm.schema.create();
});

afterAll(async () => {
  await orm?.close(true);
  unpatchMikroQueryBuilder(sql);
  unpatchMikroOrm(core);
});

beforeEach(async () => {
  await orm.em.fork().nativeDelete(UserSchema, {});
  em = orm.em.fork();
  t.reset();
});

describe('MikroORM instrumentation', () => {
  it('em.find → one span "MikroORM find User" with table and system', async () => {
    await em.find(UserSchema, { email: 'a@b.c' });
    const s = only('MikroORM find User');
    expect(s.attributes).toMatchObject({
      'db.collection.name': 'users',
      'db.system.name': 'sqlite',
      'db.orm.name': 'mikro-orm',
      'db.operation.name': 'find',
      'db.orm.entity': 'User',
    });
    expect(s.attributes['db.orm.params']).toBeUndefined();
  });

  it('string entity names resolve the entity and table', async () => {
    // v7 types only allow classes / schemas, but string names still work at runtime (and in v6 types).
    const byName = 'User' as unknown as typeof UserSchema;
    await em.find(byName, {});
    await em.getRepository(byName).count();
    expect(ormSpans().map((s) => [s.name, s.attributes['db.collection.name']])).toEqual([
      ['MikroORM find User', 'users'],
      ['MikroORM count User', 'users'],
    ]);
  });

  it('nested ORM calls produce one span', async () => {
    await em.findOne(UserSchema, { id: 1 });
    await em.findAndCount(UserSchema, {});
    expect(ormSpans().map((s) => s.name)).toEqual(['MikroORM findOne User', 'MikroORM findAndCount User']);
  });

  it('flush traced with driver work inside', async () => {
    em.persist(em.create(UserSchema, { id: 1, email: 'f', password: 'p' }));
    await em.flush();
    const s = only('MikroORM flush');
    expect(s.attributes).toMatchObject({ 'db.operation.name': 'flush', 'db.system.name': 'sqlite' });
    expect(s.attributes['db.orm.entity']).toBeUndefined();
    expect(s.attributes['db.collection.name']).toBeUndefined();
    expect(await orm.em.fork().count(UserSchema)).toBe(1);
  });

  it('transaction callback calls are traced as children', async () => {
    await em.transactional(async (em2) => {
      em2.create(UserSchema, { id: 2, email: 'tx', password: 'p' });
      await em2.flush();
      await em2.find(UserSchema, {});
    });
    const tx = only('MikroORM transactional');
    const children = ormSpans().filter((s) => s.parentSpanContext?.spanId === tx.spanContext().spanId);
    // the user's flush and find, then the transaction manager's own final flush
    expect(children.map((s) => s.name)).toEqual(['MikroORM flush', 'MikroORM find User', 'MikroORM flush']);
    expect(tx.attributes['db.orm.params']).toBeUndefined();
  });

  it('repository calls traced once via em', async () => {
    await em.getRepository(UserSchema).findAll();
    expect(ormSpans().map((s) => s.name)).toEqual(['MikroORM findAll User']);
  });

  it('instance-form insert resolves the entity from the instance', async () => {
    const user = em.create(UserSchema, { id: 3, email: 'i', password: 'p' }, { persist: false });
    await em.insert(user);
    expect(ormSpans().map((s) => [s.name, s.attributes['db.collection.name']])).toEqual([
      ['MikroORM insert User', 'users'],
    ]);
  });

  it('failure attaches redacted params', async () => {
    await em.insert(UserSchema, { id: 1, email: 'dup', password: 'hunter2' });
    t.reset();
    await expect(em.insert(UserSchema, { id: 1, email: 'dup', password: 'hunter2' })).rejects.toThrow();
    const s = only('MikroORM insert User');
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.events.some((e) => e.name === 'exception')).toBe(true);
    expect(JSON.parse(s.attributes['db.orm.params'] as string)).toEqual([
      { id: 1, email: 'dup', password: '[REDACTED]' },
    ]);
  });

  it('raw execute failure attaches its positional params (documented exception)', async () => {
    await expect(em.execute('SELECT * FROM nope WHERE password = ?', ['hunter2'])).rejects.toThrow();
    const s = only('MikroORM execute');
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.attributes['db.orm.params']).toBe('["hunter2"]');
  });

  it('query builder getResultList traced with entity and no params on success', async () => {
    await em.createQueryBuilder(UserSchema).where({ email: 'q' }).getResultList();
    const s = only('MikroORM getResultList User');
    expect(s.attributes).toMatchObject({
      'db.collection.name': 'users',
      'db.system.name': 'sqlite',
      'db.operation.name': 'getResultList',
    });
    expect(s.attributes['db.orm.params']).toBeUndefined();
    expect(ormSpans()).toHaveLength(1);
  });

  it('failed query builder insert never exposes positional parameter values', async () => {
    await em.insert(UserSchema, { id: 1, email: 'z', password: 'p' });
    t.reset();
    await expect(
      em.createQueryBuilder(UserSchema).insert({ id: 1, email: 'z', password: 'hunter2' }).execute(),
    ).rejects.toThrow();
    const params = only('MikroORM execute User').attributes['db.orm.params'] as string;
    expect(params).not.toContain('hunter2');
    const parsed = JSON.parse(params);
    expect(parsed.data).toEqual({ id: 1, email: 'z', password: '[REDACTED]' });
    expect(parsed.params.every((p: unknown) => p === '[REDACTED]')).toBe(true);
  });

  it('failed query builder update never exposes positional parameter values', async () => {
    await em.insert(UserSchema, { id: 1, email: 'a', password: 'p' });
    await em.insert(UserSchema, { id: 2, email: 'b', password: 'p' });
    t.reset();
    await expect(
      em.createQueryBuilder(UserSchema).update({ id: 1, password: 'hunter2' }).where({ id: 2 }).execute(),
    ).rejects.toThrow();
    const params = only('MikroORM execute User').attributes['db.orm.params'] as string;
    expect(params).not.toContain('hunter2');
    expect(JSON.parse(params).data).toEqual({ id: 1, password: '[REDACTED]' });
  });

  it('failed select query builder with object-form where never exposes values', async () => {
    await expect(
      em.createQueryBuilder(UserSchema).where({ password: 'hunter2' }).andWhere('nope = 1').getResultList(),
    ).rejects.toThrow();
    const params = only('MikroORM getResultList User').attributes['db.orm.params'] as string;
    expect(params).not.toContain('hunter2');
    expect(params).toContain('[REDACTED]');
  });

  it('errors and results pass through unchanged', async () => {
    const original = new Error('boom');
    expect(await em.execute('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    await expect(
      em.transactional(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it('the SQL entity manager inherits patched methods and patches its own execute once', async () => {
    const proto = sql.SqlEntityManager.prototype as unknown as Record<string, unknown>;
    expect(Object.hasOwn(proto, 'find')).toBe(false);
    expect(proto.find).toBe((core.EntityManager.prototype as unknown as Record<string, unknown>).find);
    expect(originalOf(proto.find)).toBeDefined();
    expect(Object.hasOwn(proto, 'execute')).toBe(true);
    const inner = originalOf(proto.execute);
    expect(inner).toBeDefined();
    expect(originalOf(inner)).toBeUndefined();
    expect(sql.EntityManager).toBe(sql.SqlEntityManager);
    await em.execute('SELECT 1');
    expect(ormSpans().map((s) => s.name)).toEqual(['MikroORM execute']);
  });

  it('stream is untouched', async () => {
    const stream = core.EntityManager.prototype.stream as unknown;
    expect(typeof stream).toBe('function');
    expect(originalOf(stream)).toBeUndefined();
    expect(originalOf(sql.QueryBuilder.prototype.stream)).toBeUndefined();
    expect(originalOf(core.EntityManager.prototype.find)).toBeDefined();
    await em.insert(UserSchema, { id: 9, email: 's', password: 'p' });
    t.reset();
    const rows: unknown[] = [];
    for await (const row of em.stream(UserSchema)) rows.push(row);
    expect(rows).toHaveLength(1);
  });

  it('repository methods are not patched (they delegate to the em)', () => {
    expect(originalOf(core.EntityRepository.prototype.find)).toBeUndefined();
    expect(originalOf(core.EntityManager.prototype.persist)).toBeUndefined();
  });

  it('skips absent methods', () => {
    const fake = {
      EntityManager: class {
        find() {}
      },
      QueryBuilder: class {
        execute() {}
      },
    };
    expect(() => patchMikroOrm(fake)).not.toThrow();
    expect(() => patchMikroQueryBuilder(fake)).not.toThrow();
    expect(() => unpatchMikroOrm(fake)).not.toThrow();
    expect(() => unpatchMikroQueryBuilder(fake)).not.toThrow();
    for (const exports of [{}, undefined]) {
      expect(() => patchMikroOrm(exports)).not.toThrow();
      expect(() => patchMikroQueryBuilder(exports)).not.toThrow();
    }
  });

  it('patch is idempotent', async () => {
    patchMikroOrm(core);
    patchMikroQueryBuilder(sql);
    await em.find(UserSchema, {});
    await em.createQueryBuilder(UserSchema).getResult();
    expect(ormSpans().map((s) => s.name)).toEqual(['MikroORM find User', 'MikroORM getResult User']);
  });
});

describe('unpatchMikroOrm / unpatchMikroQueryBuilder', () => {
  it('restore the original methods', () => {
    unpatchMikroOrm(core);
    unpatchMikroQueryBuilder(sql);
    try {
      expect(originalOf(core.EntityManager.prototype.find)).toBeUndefined();
      expect(originalOf(sql.SqlEntityManager.prototype.execute)).toBeUndefined();
      expect(originalOf(sql.QueryBuilder.prototype.execute)).toBeUndefined();
    } finally {
      patchMikroOrm(core);
      patchMikroQueryBuilder(sql);
    }
  });
});
