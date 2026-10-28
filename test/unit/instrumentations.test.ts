import { describe, expect, it } from 'vitest';
import { readBootstrapConfig, type BootstrapConfig } from '../../src/bootstrap/config';
import { buildInstrumentations } from '../../src/bootstrap/instrumentations';
import { isInstalled } from '../../src/bootstrap/detect';

describe('buildInstrumentations', () => {
  const names = (cfg: BootstrapConfig, inst: string[]) =>
    buildInstrumentations(cfg, (p) => inst.includes(p)).map((i) => i.instrumentationName);

  it('includes only installed and enabled', () => {
    const base = readBootstrapConfig({});
    expect(names(base, ['express'])).toEqual(
      expect.arrayContaining(['@opentelemetry/instrumentation-http', '@opentelemetry/instrumentation-express']),
    );
    expect(names(base, [])).not.toContain('@opentelemetry/instrumentation-express');
    expect(names(readBootstrapConfig({ OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'http' }), [])).not.toContain(
      '@opentelemetry/instrumentation-http',
    );
  });

  it('honours the enabled list', () => {
    const cfg = readBootstrapConfig({ OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'express' });
    expect(names(cfg, ['express', 'pino'])).toEqual(['@opentelemetry/instrumentation-express']);
  });
});

describe('isInstalled', () => {
  it('resolves packages from the given directory', () => {
    expect(isInstalled('express')).toBe(true);
    expect(isInstalled('definitely-not-a-real-package-xyz')).toBe(false);
  });
});
