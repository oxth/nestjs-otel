import type { RedactOptions } from '../../src/index';
import { describe, it, expect } from 'vitest';
import { createRedactor, serializeBody } from '../../src/redact/redactor';

const r = createRedactor();

describe('redactor', () => {
  it('redacts default keys at any depth, case-insensitive', () => {
    expect(r.redact({ user: { Password: 'x', api_key: 'k', profile: { accessToken: 't' } }, name: 'n' })).toEqual({
      user: { Password: '[REDACTED]', api_key: '[REDACTED]', profile: { accessToken: '[REDACTED]' } },
      name: 'n',
    });
  });
  it('auth is exact-match only', () => {
    expect(r.redact({ auth: 'a', author: 'b' })).toEqual({ auth: '[REDACTED]', author: 'b' });
  });
  it('redacts inside arrays', () => {
    expect(r.redact([{ secret: 1 }, { ok: 2 }])).toEqual([{ secret: '[REDACTED]' }, { ok: 2 }]);
  });
  it('applies value patterns to strings', () => {
    expect(r.redactString('t=eyJa.eyJb.sig and Bearer abc.def')).toBe('t=[REDACTED] and [REDACTED]');
  });
  it('redacts value patterns repeatedly (no regex state leak)', () => {
    expect(r.redactString('Bearer a')).toBe('[REDACTED]');
    expect(r.redactString('Bearer a')).toBe('[REDACTED]');
  });
  it('supports extra keys, replaced defaults, custom censor and custom fn', () => {
    const c = createRedactor({
      keys: ['email'],
      replaceDefaultKeys: true,
      censor: '***',
      custom: (v, p) => (p.at(-1) === 'phone' ? 'x' : v),
    });
    expect(c.redact({ email: 'a', password: 'p', phone: '1' })).toEqual({ email: '***', password: 'p', phone: 'x' });
  });
  it('uses a custom censor literally (no replacement patterns)', () => {
    const options: RedactOptions = { censor: '$&-$1' };
    const c = createRedactor(options);
    expect(c.redactString('auth Bearer abc.def')).toBe('auth $&-$1');
    expect(c.redact({ password: 'p' })).toEqual({ password: '$&-$1' });
  });

  it('does not mutate input', () => {
    const o = { password: 'p' };
    r.redact(o);
    expect(o.password).toBe('p');
  });
  it('redacts sensitive headers', () => {
    expect(r.redactHeaders({ Authorization: 'Bearer x', 'x-api-key': 'k', accept: 'json' })).toEqual({
      Authorization: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      accept: 'json',
    });
  });
  it('redact survives hostile input', () => {
    const circ: any = { a: 1 };
    circ.self = circ;
    const deep: any = {};
    let cur = deep;
    for (let i = 0; i < 50; i++) {
      cur.n = {};
      cur = cur.n;
    }
    const bad = {
      toJSON() {
        throw new Error('x');
      },
    };
    const out: any = r.redact({
      circ,
      deep,
      big: Array.from({ length: 100_000 }, (_, i) => i),
      buf: Buffer.alloc(10),
      n: 10n,
      bad,
    });
    expect(out.circ.self).toBe('[Circular]');
    expect(JSON.stringify(out)).toContain('[Truncated]');
    expect(out.big).toHaveLength(1001);
    expect(out.buf).toBe('[Buffer 10 bytes]');
    expect(out.n).toBe('10');
    expect(out.bad).toBe('[Unserializable]');
  });
  it('handles dates, throwing getters, functions and symbols', () => {
    const o: any = { d: new Date(0), f() {}, s: Symbol('x') };
    Object.defineProperty(o, 'g', {
      enumerable: true,
      get() {
        throw new Error('no');
      },
    });
    const out: any = r.redact(o);
    expect(out.d).toBe('1970-01-01T00:00:00.000Z');
    expect(out.g).toBe('[Unserializable]');
    expect('f' in out).toBe(false);
    expect('s' in out).toBe(false);
  });
});

describe('serializeBody', () => {
  it('truncates on utf-8 boundary', () => {
    const { body, truncated } = serializeBody({ s: '€'.repeat(5000) }, 8192);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(8192);
    expect(Buffer.from(body, 'utf8').toString('utf8')).toBe(body);
  });
  it('does not truncate small bodies', () => {
    expect(serializeBody({ a: 1 }, 8192)).toEqual({ body: '{"a":1}', truncated: false });
  });
});
