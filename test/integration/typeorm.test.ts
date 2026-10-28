import { SpanStatusCode } from '@opentelemetry/api';
import * as typeorm from 'typeorm';
import { DataSource, EntitySchema } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { patchTypeorm, unpatchTypeorm } from '../../src/orm/typeorm';
import { setupInMemoryTracing } from './helpers/tracing';

const ORIGINAL = Symbol.for('@oxth/nestjs-otel.orm-original');

interface User {
  id: number;
  email: string;
  password: string;
}

const UserSchema = new EntitySchema<User>({
  name: 'User',
  tableName: 'users',
  columns: {
    id: { type: Number, primary: true, generated: true },
    email: { type: String },
    password: { type: String },
  },
});

const t = setupInMemoryTracing();
let ds: DataSource;

const ormSpans = () => t.spans().filter((s) => s.attributes['db.orm.name'] === 'typeorm');
const only = (name: string) => {
  const matches = t.spans().filter((s) => s.name === name);
  expect(matches.map((s) => s.name)).toEqual([name]);
  return matches[0];
};

beforeAll(async () => {
  patchTypeorm(typeorm);
  ds = new DataSource({ type: 'sqljs', entities: [UserSchema], synchronize: true });
  await ds.initialize();
});

afterAll(async () => {
  await ds?.destroy();
  unpatchTypeorm(typeorm);
});

beforeEach(async () => {
  await ds.query('DELETE FROM users');
  t.reset();
});

describe('TypeORM instrumentation', () => {
  it('repository find → one span "TypeORM find User" with table and system', async () => {
    await ds.getRepository('User').find({ where: { email: 'a@b.c' } });
    const s = only('TypeORM find User');
    expect(s.attributes).toMatchObject({
      'db.collection.name': 'users',
      'db.system.name': 'sqlite',
      'db.orm.name': 'typeorm',
      'db.operation.name': 'find',
      'db.orm.entity': 'User',
    });
    expect(s.attributes['db.orm.params']).toBeUndefined();
  });

  it('nested ORM calls produce one span', async () => {
    await ds.manager.findOne('User', { where: { id: 1 } });
    expect(ormSpans().map((s) => s.name)).toEqual(['TypeORM findOne User']);
  });

  it('save with an entity schema target resolves the entity', async () => {
    await ds.manager.save(UserSchema, { email: 's', password: 'p' });
    expect(ormSpans().map((s) => s.name)).toEqual(['TypeORM save User']);
  });

  it('transaction callback calls are traced as children', async () => {
    await ds.manager.transaction(async (m) => {
      await m.save('User', { email: 'x', password: 'p' });
    });
    const tx = only('TypeORM transaction');
    const save = only('TypeORM save User');
    expect(save.parentSpanContext?.spanId).toBe(tx.spanContext().spanId);
    expect(tx.attributes['db.orm.params']).toBeUndefined();
  });

  it('query builder getMany traced with entity and no params on success', async () => {
    await ds.getRepository('User').createQueryBuilder('u').where('u.email = :email', { email: 'q' }).getMany();
    const s = only('TypeORM getMany User');
    expect(s.attributes).toMatchObject({
      'db.collection.name': 'users',
      'db.system.name': 'sqlite',
      'db.operation.name': 'getMany',
    });
    expect(s.attributes['db.orm.params']).toBeUndefined();
    expect(ormSpans()).toHaveLength(1);
  });

  it('insert query builder execute traced', async () => {
    await ds.createQueryBuilder().insert().into('User').values({ email: 'i', password: 'p' }).execute();
    const s = only('TypeORM insert User');
    expect(s.attributes).toMatchObject({ 'db.collection.name': 'users', 'db.operation.name': 'insert' });
    expect(ormSpans()).toHaveLength(1);
  });

  it('failure attaches redacted params and records exception', async () => {
    await expect(ds.manager.query('SELECT * FROM nope WHERE password = ?', ['hunter2'])).rejects.toThrow();
    const s = only('TypeORM query');
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.events.some((e) => e.name === 'exception')).toBe(true);
    expect(s.attributes['db.orm.entity']).toBeUndefined();
    expect(s.attributes['db.orm.params']).toBe('["hunter2"]');
  });

  it('failure with keyed params redacts sensitive keys', async () => {
    await ds.manager.insert('User', { id: 1, email: 'dup', password: 'hunter2' });
    t.reset();
    await expect(ds.manager.insert('User', { id: 1, email: 'dup', password: 'hunter2' })).rejects.toThrow();
    const s = only('TypeORM insert User');
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.parse(s.attributes['db.orm.params'] as string)).toEqual([
      { id: 1, email: 'dup', password: '[REDACTED]' },
    ]);
  });

  it('errors and results pass through unchanged', async () => {
    const original = new Error('boom');
    const em = ds.manager;
    const res = await em.query('SELECT 1 AS one');
    expect(res).toEqual([{ one: 1 }]);
    await expect(
      em.transaction(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it('stream is untouched', () => {
    const stream = typeorm.SelectQueryBuilder.prototype.stream as unknown as Record<symbol, unknown>;
    expect(typeof stream).toBe('function');
    expect(stream[ORIGINAL]).toBeUndefined();
    expect((typeorm.SelectQueryBuilder.prototype.getMany as unknown as Record<symbol, unknown>)[ORIGINAL]).toBeDefined();
  });

  it('repository methods are not patched (they delegate to the manager)', () => {
    expect((typeorm.Repository.prototype.find as unknown as Record<symbol, unknown>)[ORIGINAL]).toBeUndefined();
  });

  it('skips absent methods', () => {
    const fake = {
      EntityManager: class {
        find() {}
      },
    };
    expect(() => patchTypeorm(fake)).not.toThrow();
    expect(() => unpatchTypeorm(fake)).not.toThrow();
    expect(() => patchTypeorm({})).not.toThrow();
    expect(() => patchTypeorm(undefined)).not.toThrow();
  });

  it('patchTypeorm is idempotent', async () => {
    patchTypeorm(typeorm);
    await ds.manager.find('User');
    expect(ormSpans().map((s) => s.name)).toEqual(['TypeORM find User']);
  });
});

describe('unpatchTypeorm', () => {
  it('restores the original methods', () => {
    const before = typeorm.EntityManager.prototype.find;
    unpatchTypeorm(typeorm);
    try {
      expect((typeorm.EntityManager.prototype.find as unknown as Record<symbol, unknown>)[ORIGINAL]).toBeUndefined();
      expect(typeorm.EntityManager.prototype.find).not.toBe(before);
    } finally {
      patchTypeorm(typeorm);
    }
  });
});
