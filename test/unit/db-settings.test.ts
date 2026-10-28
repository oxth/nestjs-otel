import { describe, expect, it } from 'vitest';
import { getDbSettings, resolveDbSettings, setDbSettings } from '../../src/orm/settings';
import { createRedactor, setDefaultRedactor } from '../../src/redact/redactor';

describe('db settings', () => {
  it('defaults', () => expect(resolveDbSettings()).toEqual({ captureParams: 'error', maxParamsBytes: 2048 }));
  it('getDbSettings falls back to defaults and reads global state', () => {
    expect(getDbSettings().captureParams).toBe('error');
    setDbSettings({ captureParams: 'always', maxParamsBytes: 10 });
    expect((globalThis as any)[Symbol.for('@oxth/nestjs-otel.state')].db.captureParams).toBe('always');
    setDbSettings(resolveDbSettings());
  });
  it('default redactor lives in global state', () => {
    const r = createRedactor({ keys: ['zzz'] });
    setDefaultRedactor(r);
    expect((globalThis as any)[Symbol.for('@oxth/nestjs-otel.state')].redactor).toBe(r);
  });
});
