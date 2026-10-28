import { describe, expect, it } from 'vitest';
import { readBootstrapConfig } from '../../src/bootstrap/config';

describe('readBootstrapConfig', () => {
  it('reads standard env vars', () => {
    expect(readBootstrapConfig({ OTEL_SDK_DISABLED: 'true' }).disabled).toBe(true);
    const c = readBootstrapConfig({
      OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'http, express',
      OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'pino',
    });
    expect([...c.enabled!]).toEqual(['http', 'express']);
    expect(c.disabledInstrumentations.has('pino')).toBe(true);
  });

  it('defaults to enabled, all instrumentations', () => {
    const c = readBootstrapConfig({});
    expect(c.disabled).toBe(false);
    expect(c.enabled).toBeNull();
    expect(c.disabledInstrumentations.size).toBe(0);
  });
});
