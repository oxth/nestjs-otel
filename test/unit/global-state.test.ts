import { describe, expect, it } from 'vitest';
import { safely } from '../../src/shared/safe';

describe('global state', () => {
  it('shares state through globalThis', async () => {
    const a = await import('../../src/shared/global-state');
    a.getGlobalState().registered = true;
    expect((globalThis as any)[Symbol.for('@oxth/nestjs-otel.state')].registered).toBe(true);
  });

  it('creates state lazily with defaults', async () => {
    delete (globalThis as any)[Symbol.for('@oxth/nestjs-otel.state')];
    const { getGlobalState } = await import('../../src/shared/global-state');
    const s = getGlobalState();
    expect(s.registered).toBe(false);
    expect(s.warned).toBeInstanceOf(Set);
    expect(getGlobalState()).toBe(s);
  });
});

describe('safely', () => {
  it('returns fallback and never throws', () => {
    expect(
      safely(
        'x',
        () => {
          throw new Error('no');
        },
        42,
      ),
    ).toBe(42);
  });

  it('returns the value on success', () => {
    expect(safely('x', () => 7, 0)).toBe(7);
  });
});
