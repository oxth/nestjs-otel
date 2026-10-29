import { describe, expect, it } from 'vitest';
import { esmHookIncludeList } from '../../src/bootstrap/esm-hook';

const inst = (...names: string[]) => ({ getModuleDefinitions: () => names.map((name) => ({ name })) });

describe('esmHookIncludeList', () => {
  it('lists every module the instrumentations hook, once', () => {
    expect(esmHookIncludeList([inst('http', 'https'), inst('express'), inst('http')] as never)).toEqual([
      'http',
      'https',
      'express',
    ]);
  });

  it('skips instrumentations that throw or have no definitions', () => {
    const broken = {
      getModuleDefinitions: () => {
        throw new Error('boom');
      },
    };
    expect(esmHookIncludeList([broken, {}, inst('pg')] as never)).toEqual(['pg']);
  });

  it('includes the registry modules', async () => {
    const { buildInstrumentations } = await import('../../src/bootstrap/instrumentations');
    const list = esmHookIncludeList(
      buildInstrumentations({ disabled: false, enabled: null, disabledInstrumentations: new Set() } as never, () => true),
    );
    for (const name of ['http', 'express', 'pino', 'pg', 'typeorm', '@mikro-orm/core', 'bullmq', 'kafkajs', 'ioredis']) {
      expect(list).toContain(name);
    }
  });
});
