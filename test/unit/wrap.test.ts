import { SpanStatusCode, trace } from '@opentelemetry/api';
import { lastValueFrom, of, throwError } from 'rxjs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { WRAPPED } from '../../src/shared/symbols';
import { copyMethodMetadata } from '../../src/tracing/copy-metadata';
import { isWrapped, wrapForErrorRecording, wrapMethod } from '../../src/tracing/wrap';
import { setupInMemoryTracing } from '../integration/helpers/tracing';

const t = setupInMemoryTracing();
afterAll(() => t.shutdown());

const classify = () => ({ treat4xxAsError: false });

describe('wrapMethod', () => {
  it('sync method: same return value, span ended', () => {
    const w = wrapMethod(
      function (this: any, a: number) {
        return this.k + a;
      },
      { spanName: 'C.m', classify },
    );
    expect(w.call({ k: 1 }, 2)).toBe(3);
    expect(t.spans()).toHaveLength(1);
    expect(t.spans()[0].name).toBe('C.m');
  });

  it('sync throw records error, ends span and rethrows same error', () => {
    const e = new Error('boom');
    const w = wrapMethod(
      () => {
        throw e;
      },
      { spanName: 'C.t', classify },
    );
    expect(() => w()).toThrow(e);
    expect(t.spans()).toHaveLength(1);
    expect(t.spans()[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('async resolution returns the same value', async () => {
    const value = { a: 1 };
    const w = wrapMethod(async () => value, { spanName: 'C.a', classify });
    await expect(w()).resolves.toBe(value);
    expect(t.spans()).toHaveLength(1);
    expect(t.spans()[0].status.code).toBe(SpanStatusCode.UNSET);
  });

  it('async rejection records error and rethrows same error', async () => {
    const e = new Error('x');
    const w = wrapMethod(
      async () => {
        throw e;
      },
      { spanName: 'C.m', classify },
    );
    await expect(w()).rejects.toBe(e);
    expect(t.spans()[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('observable ends span on complete and on error', async () => {
    const w = wrapMethod(() => of(1, 2), { spanName: 'C.o', classify });
    const obs = w();
    expect(t.spans()).toHaveLength(0); // not ended before subscription completes
    expect(await lastValueFrom(obs)).toBe(2);
    expect(t.spans()).toHaveLength(1);

    const e = new Error('obs');
    const we = wrapMethod(() => throwError(() => e), { spanName: 'C.oe', classify });
    await expect(lastValueFrom(we())).rejects.toBe(e);
    expect(t.spans()).toHaveLength(2);
    expect(t.spans()[1].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('nested wrapped calls produce parent/child and one exception event', async () => {
    const inner = wrapMethod(
      async () => {
        throw new Error('deep');
      },
      { spanName: 'S.inner', classify },
    );
    const outer = wrapMethod(async () => inner(), { spanName: 'C.outer', classify });
    await outer().catch(() => {});
    const [i, o] = t.spans();
    expect(i.name).toBe('S.inner');
    expect(i.parentSpanContext?.spanId).toBe(o.spanContext().spanId);
    expect(i.events.filter((e) => e.name === 'exception')).toHaveLength(1);
    expect(o.events).toHaveLength(0);
    expect(o.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('copies reflect metadata, name and length', () => {
    function orig(_a: any, _b: any) {}
    Reflect.defineMetadata('path', '/x', orig);
    const w = wrapMethod(orig, { spanName: 'n', classify });
    expect(Reflect.getMetadata('path', w)).toBe('/x');
    expect(w.name).toBe('orig');
    expect(w.length).toBe(2);
  });

  it('paramAttributes records primitives only', () => {
    const w = wrapMethod((_id: string, _o: object, _n: number, _b: boolean) => 1, {
      spanName: 'n',
      classify,
      paramAttributes: [
        { index: 0, name: 'user.id' },
        { index: 1, name: 'obj' },
        { index: 2, name: 'num' },
        { index: 3, name: 'flag' },
      ],
    });
    w('42', {}, 7, false);
    expect(t.spans()[0].attributes).toMatchObject({ 'user.id': '42', num: 7, flag: false });
    expect(t.spans()[0].attributes.obj).toBeUndefined();
  });

  it('marks wrapper as wrapped', () => {
    const w = wrapMethod(() => 1, { spanName: 'n', classify });
    expect(isWrapped(w)).toBe(true);
    expect((w as any)[WRAPPED]).toBe(true);
    expect(isWrapped(() => 1)).toBe(false);
    expect(isWrapped(undefined)).toBe(false);
  });

  it('a broken tracer never changes the method behaviour', async () => {
    const spy = vi.spyOn(trace, 'getTracer').mockImplementation(() => {
      throw new Error('tracer broken');
    });
    try {
      const fn = vi.fn((a: number) => a * 2);
      const w = wrapMethod(fn, { spanName: 'n', classify });
      expect(w(21)).toBe(42);
      expect(fn).toHaveBeenCalledTimes(1);

      const e = new Error('user');
      const thrower = vi.fn(() => {
        throw e;
      });
      expect(() => wrapMethod(thrower, { spanName: 'n', classify })()).toThrow(e);
      expect(thrower).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('a throwing span or classify never changes the method behaviour', async () => {
    const broken = {
      end: () => {
        throw new Error('end broken');
      },
      setStatus: () => {
        throw new Error('status broken');
      },
      addEvent: () => {
        throw new Error('event broken');
      },
      setAttribute: () => {
        throw new Error('attr broken');
      },
    };
    const spy = vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan: () => broken as any,
      startActiveSpan: (_n: string, _o: unknown, fn: (s: unknown) => unknown) => fn(broken),
    } as any);
    try {
      const fn = vi.fn(() => 5);
      expect(wrapMethod(fn, { spanName: 'n', classify })()).toBe(5);
      expect(fn).toHaveBeenCalledTimes(1);

      const e = new Error('user');
      const badClassify = () => {
        throw new Error('classify broken');
      };
      await expect(
        wrapMethod(
          async () => {
            throw e;
          },
          { spanName: 'n', classify: badClassify },
        )(),
      ).rejects.toBe(e);
      expect(() =>
        wrapMethod(
          () => {
            throw e;
          },
          { spanName: 'n', classify },
        )(),
      ).toThrow(e);
    } finally {
      spy.mockRestore();
    }
  });

  it('a tracer throwing after running the callback does not call the method twice', () => {
    const spy = vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan: (_n: string, _o: unknown, fn: (s: unknown) => unknown) => {
        fn({ end() {}, setStatus() {}, addEvent() {}, setAttribute() {} });
        throw new Error('after');
      },
    } as any);
    try {
      const fn = vi.fn(() => 'v');
      expect(wrapMethod(fn, { spanName: 'n', classify })()).toBe('v');
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('wrapForErrorRecording', () => {
  it('reports sync, async and observable errors with args and rethrows', async () => {
    const onError = vi.fn();
    const e = new Error('e');
    const sync = wrapForErrorRecording((_a: number) => {
      throw e;
    }, onError);
    expect(() => sync(1)).toThrow(e);
    expect(onError).toHaveBeenLastCalledWith(e, [1]);

    const asyncFn = wrapForErrorRecording(async (_a: string) => {
      throw e;
    }, onError);
    await expect(asyncFn('x')).rejects.toBe(e);
    expect(onError).toHaveBeenLastCalledWith(e, ['x']);

    const obs = wrapForErrorRecording(() => throwError(() => e), onError);
    await expect(lastValueFrom(obs())).rejects.toBe(e);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(isWrapped(obs)).toBe(true);
    expect(t.spans()).toHaveLength(0);
  });

  it('keeps this and return value; a throwing onError is swallowed', () => {
    const e = new Error('user');
    const w = wrapForErrorRecording(
      function (this: { k: number }) {
        if (this.k < 0) throw e;
        return this.k;
      },
      () => {
        throw new Error('hook broken');
      },
    );
    expect(w.call({ k: 3 })).toBe(3);
    expect(() => w.call({ k: -1 })).toThrow(e);
  });
});

describe('copyMethodMetadata', () => {
  it('copies own metadata and enumerable props', () => {
    function from() {}
    (from as any).custom = 1;
    Reflect.defineMetadata('k', 'v', from);
    const to = function () {};
    copyMethodMetadata(from, to);
    expect(Reflect.getOwnMetadata('k', to)).toBe('v');
    expect((to as any).custom).toBe(1);
    expect(to.name).toBe('from');
  });
});
