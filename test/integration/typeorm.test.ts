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
  deletedAt?: Date | null;
}

const UserSchema = new EntitySchema<User>({
  name: 'User',
  tableName: 'users',
  columns: {
    id: { type: Number, primary: true, generated: true },
    email: { type: String },
    password: { type: String },
    deletedAt: { type: 'datetime', deleteDate: true, nullable: true },
  },
});

class Note {
  id!: number;
  body!: string;
  deletedAt?: Date | null;
}

const NoteSchema = new EntitySchema<Note>({
  name: 'Note',
  target: Note,
  tableName: 'notes',
  columns: {
    id: { type: Number, primary: true, generated: true },
    body: { type: String },
    deletedAt: { type: 'datetime', deleteDate: true, nullable: true },
  },
});

const note = (body: string) => Object.assign(new Note(), { body });

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
  ds = new DataSource({ type: 'sqljs', entities: [UserSchema, NoteSchema], synchronize: true });
  await ds.initialize();
});

afterAll(async () => {
  await ds?.destroy();
  unpatchTypeorm(typeorm);
});

beforeEach(async () => {
  await ds.query('DELETE FROM users');
  await ds.query('DELETE FROM notes');
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

  it('updateAll, deleteAll, recover and preload get one span each', async () => {
    await ds.manager.insert('User', { id: 7, email: 'r', password: 'p' });
    t.reset();
    await ds.manager.updateAll('User', { email: 'all' });
    await ds.manager.preload('User', { id: 7, email: 'pre' });
    await ds.manager.recover('User', { id: 7, email: 'all', password: 'p' });
    await ds.manager.deleteAll('User');
    expect(ormSpans().map((s) => s.name)).toEqual([
      'TypeORM updateAll User',
      'TypeORM preload User',
      'TypeORM recover User',
      'TypeORM deleteAll User',
    ]);
    expect(only('TypeORM deleteAll User').attributes['db.collection.name']).toBe('users');
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
    expect(s.attributes['db.orm.params']).toBe('["[REDACTED]"]');
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

  it('failed query builder insert never exposes generated parameter values', async () => {
    await ds.manager.insert('User', { id: 1, email: 'z', password: 'p' });
    t.reset();
    await expect(
      ds.createQueryBuilder().insert().into('User').values({ id: 1, email: 'z', password: 'hunter2' }).execute(),
    ).rejects.toThrow();
    const params = only('TypeORM insert User').attributes['db.orm.params'] as string;
    expect(params).not.toContain('hunter2');
    expect(params).toContain('[REDACTED]');
    expect(JSON.parse(params).values).toEqual({ id: 1, email: 'z', password: '[REDACTED]' });
  });

  it('failed query builder update never exposes generated parameter values', async () => {
    await ds.manager.insert('User', [
      { id: 1, email: 'a', password: 'p' },
      { id: 2, email: 'b', password: 'p' },
    ]);
    t.reset();
    await expect(
      ds
        .createQueryBuilder()
        .update('User')
        .set({ id: 1, password: 'hunter2' })
        .where('id = :id', { id: 2 })
        .execute(),
    ).rejects.toThrow();
    const params = only('TypeORM update User').attributes['db.orm.params'] as string;
    expect(params).not.toContain('hunter2');
    expect(params).toContain('[REDACTED]');
    expect(JSON.parse(params).parameters.id).toBe(2);
  });

  it('failed select query builder with object-form where never exposes values', async () => {
    await expect(
      ds.getRepository('User').createQueryBuilder('u').where({ password: 'hunter2' }).andWhere('nope = 1').getMany(),
    ).rejects.toThrow();
    const params = only('TypeORM getMany User').attributes['db.orm.params'] as string;
    expect(params).not.toContain('hunter2');
    expect(params).toContain('[REDACTED]');
  });

  it('instance-form save/remove/recover resolve the entity from the instance', async () => {
    const one = await ds.manager.save(note('a'));
    const many = await ds.manager.save([note('b'), note('c')]);
    await ds.manager.softRemove(one);
    await ds.manager.recover(one);
    await ds.manager.recover([...many]);
    await ds.manager.remove(many);
    await ds.manager.remove(one);
    expect(ormSpans().map((s) => s.name)).toEqual([
      'TypeORM save Note',
      'TypeORM save Note',
      'TypeORM softRemove Note',
      'TypeORM recover Note',
      'TypeORM recover Note',
      'TypeORM remove Note',
      'TypeORM remove Note',
    ]);
    expect(ormSpans().every((s) => s.attributes['db.collection.name'] === 'notes')).toBe(true);
  });

  it('class target resolves the entity', async () => {
    await ds.manager.find(Note);
    await ds.manager.save(Note, { body: 'x' });
    expect(ormSpans().map((s) => [s.name, s.attributes['db.collection.name']])).toEqual([
      ['TypeORM find Note', 'notes'],
      ['TypeORM save Note', 'notes'],
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

  it('MongoEntityManager own overrides are traced; inherited methods are not shadowed', () => {
    class EntityManager {
      find() {
        return 'base';
      }
      save() {
        return 'saved';
      }
    }
    class MongoEntityManager extends EntityManager {
      override find() {
        return 'mongo';
      }
    }
    const fake = { EntityManager, MongoEntityManager };
    patchTypeorm(fake);
    try {
      expect(new MongoEntityManager().find()).toBe('mongo');
      expect(only('TypeORM find')).toBeDefined();
      expect(Object.hasOwn(MongoEntityManager.prototype, 'save')).toBe(false);
      expect(new MongoEntityManager().save()).toBe('saved');
    } finally {
      unpatchTypeorm(fake);
    }
    expect((MongoEntityManager.prototype.find as unknown as Record<symbol, unknown>)[ORIGINAL]).toBeUndefined();
    expect(Object.hasOwn(MongoEntityManager.prototype, 'save')).toBe(false);
    expect(new MongoEntityManager().find()).toBe('mongo');
  });

  it('real MongoEntityManager own methods carry the patch marker', () => {
    const proto = typeorm.MongoEntityManager.prototype as unknown as Record<string, Record<symbol, unknown>>;
    for (const name of ['find', 'findOneBy', 'insert', 'count']) {
      expect(Object.hasOwn(proto, name)).toBe(true);
      expect(proto[name]![ORIGINAL]).toBeDefined();
    }
    expect(Object.hasOwn(proto, 'save')).toBe(false);
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
      const mongo = typeorm.MongoEntityManager.prototype as unknown as Record<string, Record<symbol, unknown>>;
      expect(mongo.find![ORIGINAL]).toBeUndefined();
      expect(Object.hasOwn(mongo, 'save')).toBe(false);
    } finally {
      patchTypeorm(typeorm);
    }
  });
});
