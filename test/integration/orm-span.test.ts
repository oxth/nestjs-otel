import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOrmSpan } from '../../src/orm/orm-span';
import { type MethodWrapper, patchMethods, unpatchMethods } from '../../src/orm/patch';
import { resolveDbSettings, setDbSettings } from '../../src/orm/settings';
import { setupInMemoryTracing } from './helpers/tracing';

const t = setupInMemoryTracing();
afterEach(() => setDbSettings(resolveDbSettings()));

const save = (params?: () => unknown, fail = false) =>
  runOrmSpan({ orm: 'typeorm', operation: 'save', entity: 'User', params }, async () => {
    if (fail) throw new Error('dup');
    return 1;
  });

describe('runOrmSpan', () => {
  it('creates span with name and attributes', async () => {
    await runOrmSpan(
      { orm: 'typeorm', operation: 'find', entity: 'User', collection: 'users', system: 'postgresql' },
      async () => 1,
    );
    const [s] = t.spans();
    expect(s.name).toBe('TypeORM find User');
    expect(s.kind).toBe(SpanKind.INTERNAL);
    expect(s.attributes).toMatchObject({
      'db.orm.name': 'typeorm',
      'db.operation.name': 'find',
      'db.orm.entity': 'User',
      'db.collection.name': 'users',
      'db.system.name': 'postgresql',
    });
  });

  it('omits undefined attributes and entity from the name', async () => {
    await runOrmSpan({ orm: 'mikro-orm', operation: 'flush' }, () => 1);
    const [s] = t.spans();
    expect(s.name).toBe('MikroORM flush');
    expect(Object.keys(s.attributes).sort()).toEqual(['db.operation.name', 'db.orm.name']);
  });

  it('nested leaf call is a pass-through', async () => {
    await runOrmSpan({ orm: 'typeorm', operation: 'findOne', entity: 'User' }, async () => {
      await Promise.resolve();
      return runOrmSpan({ orm: 'typeorm', operation: 'getOne' }, async () => 1);
    });
    expect(t.spans().map((s) => s.name)).toEqual(['TypeORM findOne User']);
  });

  it('calls inside a container get their own child spans', async () => {
    await runOrmSpan({ orm: 'mikro-orm', operation: 'transactional', scope: 'container' }, async () => {
      await Promise.resolve();
      return runOrmSpan({ orm: 'mikro-orm', operation: 'flush' }, async () => 1);
    });
    const [child, parent] = t.spans();
    expect(child.name).toBe('MikroORM flush');
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it('error: records exception, attaches redacted params, rethrows same error', async () => {
    const e = new Error('dup');
    await expect(
      runOrmSpan(
        { orm: 'typeorm', operation: 'save', entity: 'User', params: () => [{ email: 'a@b.c', password: 'hunter2' }] },
        async () => {
          throw e;
        },
      ),
    ).rejects.toBe(e);
    const [s] = t.spans();
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.parse(s.attributes['db.orm.params'] as string)).toEqual([{ email: 'a@b.c', password: '[REDACTED]' }]);
  });

  it('sync throw: params attached, same error rethrown, fn called once', () => {
    const e = new Error('boom');
    const fn = vi.fn(() => {
      throw e;
    });
    expect(() => runOrmSpan({ orm: 'typeorm', operation: 'x', params: () => ({ a: 1 }) }, fn)).toThrow(e);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(t.spans()[0].attributes['db.orm.params']).toBe('{"a":1}');
  });

  it('success: params only with captureParams always', async () => {
    await save(() => ({ a: 1 }));
    expect(t.spans()[0].attributes['db.orm.params']).toBeUndefined();
    t.reset();
    setDbSettings({ captureParams: 'always', maxParamsBytes: 2048 });
    await save(() => ({ a: 1 }));
    expect(t.spans()[0].attributes['db.orm.params']).toBe('{"a":1}');
  });

  it('captureParams never: no params even on error', async () => {
    setDbSettings({ captureParams: 'never', maxParamsBytes: 2048 });
    await expect(save(() => ({ a: 1 }), true)).rejects.toThrow('dup');
    expect(t.spans()[0].attributes['db.orm.params']).toBeUndefined();
  });

  it('params thunk not called unless captured', async () => {
    const thunk = vi.fn(() => 1);
    await save(thunk);
    expect(thunk).not.toHaveBeenCalled();
    setDbSettings({ captureParams: 'never', maxParamsBytes: 2048 });
    await expect(save(thunk, true)).rejects.toThrow();
    expect(thunk).not.toHaveBeenCalled();
    setDbSettings({ captureParams: 'error', maxParamsBytes: 2048 });
    await expect(save(thunk, true)).rejects.toThrow();
    expect(thunk).toHaveBeenCalledTimes(1);
  });

  it('params over maxParamsBytes are truncated and flagged', async () => {
    setDbSettings({ captureParams: 'error', maxParamsBytes: 10 });
    await expect(save(() => ({ text: 'x'.repeat(100) }), true)).rejects.toThrow();
    const [s] = t.spans();
    expect(Buffer.byteLength(s.attributes['db.orm.params'] as string)).toBeLessThanOrEqual(10);
    expect(s.attributes['db.orm.params.truncated']).toBe(true);
  });

  it('a throwing params thunk never affects the call', async () => {
    const e = new Error('dup');
    await expect(
      runOrmSpan(
        {
          orm: 'typeorm',
          operation: 'save',
          params: () => {
            throw new Error('thunk');
          },
        },
        async () => {
          throw e;
        },
      ),
    ).rejects.toBe(e);
    expect(t.spans()[0].attributes['db.orm.params']).toBeUndefined();
    expect(t.spans()[0].status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('patchMethods', () => {
  it('skips absent methods, is idempotent, unpatch restores', () => {
    class A {
      find() {
        return 1;
      }
    }
    const w: MethodWrapper = (orig) =>
      function (this: any, ...a) {
        return orig.apply(this, a) + 1;
      };
    expect(patchMethods(A.prototype, ['find', 'missing'], w)).toEqual(['find']);
    expect(patchMethods(A.prototype, ['find'], w)).toEqual([]);
    expect(new A().find()).toBe(2);
    unpatchMethods(A.prototype, ['find']);
    expect(new A().find()).toBe(1);
  });

  it('keeps this, name and length; tolerates undefined proto', () => {
    class A {
      v = 5;
      m(_a: number, _b: number) {
        return this.v;
      }
    }
    patchMethods(A.prototype, ['m'], (orig) => function (this: any, ...a) { return orig.apply(this, a); });
    expect(new A().m(1, 2)).toBe(5);
    expect(A.prototype.m.name).toBe('m');
    expect(A.prototype.m.length).toBe(2);
    expect(patchMethods(undefined, ['m'], (o) => o)).toEqual([]);
    unpatchMethods(undefined, ['m']);
  });
});
