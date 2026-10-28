import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readBootstrapConfig, type BootstrapConfig } from '../../src/bootstrap/config';
import { buildInstrumentations } from '../../src/bootstrap/instrumentations';
import { ADAPTER_PACKAGES, isInstalled } from '../../src/bootstrap/detect';

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

  it('db entries included only when installed', () => {
    const n = (inst: string[]) => names(readBootstrapConfig({}), inst);
    expect(n(['pg', 'typeorm'])).toEqual(
      expect.arrayContaining(['@opentelemetry/instrumentation-pg', '@oxth/nestjs-otel/instrumentation-typeorm']),
    );
    expect(n([])).not.toContain('@opentelemetry/instrumentation-mysql2');
  });

  it('db entries can be disabled by name', () => {
    const cfg = readBootstrapConfig({ OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'pg,mikro-orm' });
    const all = ['pg', 'mysql2', 'mongodb', 'typeorm', '@mikro-orm/core'];
    const result = names(cfg, all);
    expect(result).not.toContain('@opentelemetry/instrumentation-pg');
    expect(result).toContain('@opentelemetry/instrumentation-mysql2');
    expect(result.some((x) => x.includes('mikro'))).toBe(false);
  });

  const find = (name: string, pkgs: string[]) =>
    buildInstrumentations(readBootstrapConfig({}), (p) => pkgs.includes(p)).find((i) => i.instrumentationName === name)!;

  it('mikro-orm entry enabled when @mikro-orm/core installed', () => {
    expect(names(readBootstrapConfig({}), ['@mikro-orm/core'])).toContain('@oxth/nestjs-otel/instrumentation-mikro-orm');
  });

  it('declares the MikroORM driver adapters', () => {
    expect(ADAPTER_PACKAGES.pg).toEqual(['@mikro-orm/postgresql']);
    expect(ADAPTER_PACKAGES.mysql2).toEqual(['@mikro-orm/mysql', '@mikro-orm/mariadb']);
    expect(ADAPTER_PACKAGES.mongodb).toEqual(['@mikro-orm/mongodb']);
  });

  it('mysql2 masks statements by default', () => {
    const inst = find('@opentelemetry/instrumentation-mysql2', ['mysql2']);
    expect((inst.getConfig() as { maskStatement?: boolean }).maskStatement).toBe(true);
  });

  it('mongodb does not report enhanced database values', () => {
    const inst = find('@opentelemetry/instrumentation-mongodb', ['mongodb']);
    expect((inst.getConfig() as { enhancedDatabaseReporting?: boolean }).enhancedDatabaseReporting).toBe(false);
  });

  it('pg requestHook masks literals', () => {
    const inst = find('@opentelemetry/instrumentation-pg', ['pg']);
    const cfg = inst.getConfig() as {
      enhancedDatabaseReporting?: boolean;
      requestHook: (span: unknown, info: unknown) => void;
    };
    expect(cfg.enhancedDatabaseReporting).toBe(false);
    const calls: Array<[string, unknown]> = [];
    const span = { attributes: { 'db.statement': 'x' }, setAttribute: (k: string, v: unknown) => void calls.push([k, v]) };
    cfg.requestHook(span, { query: { text: "SELECT * FROM u WHERE pw = 'hunter2' AND \"c\" = $1" } });
    expect(calls).toEqual([
      ['db.query.text', 'SELECT * FROM u WHERE pw = ? AND "c" = $1'],
      ['db.statement', 'SELECT * FROM u WHERE pw = ? AND "c" = $1'],
    ]);
    expect(() => cfg.requestHook({ setAttribute() { throw new Error('boom'); } }, { query: { text: 'x' } })).not.toThrow();
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
  const adapters = { 'oxth-fake-http': ['@oxth-fake/platform'] };

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

  it('tries each adapter in order (pg via @mikro-orm/postgresql)', () => {
    const r = mkdtempSync(join(tmpdir(), 'oxth-detect-pg-'));
    try {
      const mk = (dir: string, name: string) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
        writeFileSync(join(dir, 'index.js'), '');
      };
      const adapter = join(r, 'node_modules/@mikro-orm/postgresql');
      mk(adapter, '@mikro-orm/postgresql');
      mk(join(adapter, 'node_modules/pg'), 'pg');
      expect(isInstalled('pg', [r], { pg: ['@mikro-orm/mysql', '@mikro-orm/postgresql'] })).toBe(true);
      expect(isInstalled('pg', [r], {})).toBe(false);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
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
