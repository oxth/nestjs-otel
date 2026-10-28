import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
  // pnpm-style isolated layout: the app depends on the adapter only; the adapter's own
  // dependency lives next to it in the store and is not resolvable from the app.
  const root = mkdtempSync(join(tmpdir(), 'oxth-detect-'));
  const store = join(root, 'store/node_modules');
  const app = join(root, 'app');
  const bin = join(root, 'bin');
  const writePkg = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), '');
  };
  writePkg(join(store, 'oxth-fake-http'), 'oxth-fake-http');
  writePkg(join(store, '@oxth-fake/platform'), '@oxth-fake/platform');
  mkdirSync(join(app, 'node_modules/@oxth-fake'), { recursive: true });
  symlinkSync(join(store, '@oxth-fake/platform'), join(app, 'node_modules/@oxth-fake/platform'), 'dir');
  writePkg(join(bin, 'node_modules/oxth-fake-cli-only'), 'oxth-fake-cli-only');
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const adapters = { 'oxth-fake-http': '@oxth-fake/platform' };

  it('resolves packages from the given directories', () => {
    expect(isInstalled('vitest')).toBe(true);
    expect(isInstalled('definitely-not-a-real-package-xyz')).toBe(false);
    expect(isInstalled('oxth-fake-cli-only', [app])).toBe(false);
    expect(isInstalled('oxth-fake-cli-only', [app, bin])).toBe(true);
  });

  it('resolves an adapter dependency through the Nest adapter package (pnpm layout)', () => {
    expect(isInstalled('oxth-fake-http', [app], {})).toBe(false);
    expect(isInstalled('oxth-fake-http', [app], adapters)).toBe(true);
  });

  it('looks next to the entry script by default', () => {
    const argv1 = process.argv[1];
    process.argv[1] = join(bin, 'main.js');
    try {
      expect(isInstalled('oxth-fake-cli-only')).toBe(true);
    } finally {
      process.argv[1] = argv1!;
    }
  });
});

describe('http instrumentation query redaction', () => {
  const http = () => {
    const inst = buildInstrumentations(readBootstrapConfig({}), () => false).find(
      (i) => i.instrumentationName === '@opentelemetry/instrumentation-http',
    )!;
    return inst.getConfig() as { redactedQueryParams?: string[]; redactedQueryParamsServer?: string[] };
  };

  it.each(['redactedQueryParams', 'redactedQueryParamsServer'] as const)('%s covers credentials and keeps the built-in list', (key) => {
    const list = http()[key]!;
    for (const name of ['token', 'access_token', 'refresh_token', 'id_token', 'api_key', 'apikey', 'password', 'secret', 'code']) {
      expect(list).toContain(name);
    }
    for (const name of ['sig', 'Signature', 'AWSAccessKeyId', 'X-Amz-Security-Token']) expect(list).toContain(name);
  });
});
