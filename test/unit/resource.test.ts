import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildResourceAttributes } from '../../src/bootstrap/resource';

describe('buildResourceAttributes', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'otel-res-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'svc', version: '1.2.3' }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults name, version, env from package.json and NODE_ENV', () => {
    expect(buildResourceAttributes({ NODE_ENV: 'production' }, dir)).toMatchObject({
      'service.name': 'svc',
      'service.version': '1.2.3',
      'deployment.environment.name': 'production',
    });
  });

  it('env wins over package.json', () => {
    expect(buildResourceAttributes({ OTEL_RESOURCE_ATTRIBUTES: 'service.version=9' }, dir)['service.version']).toBeUndefined();
    expect(
      buildResourceAttributes({ NODE_ENV: 'production', OTEL_RESOURCE_ATTRIBUTES: 'a=b,deployment.environment.name=x' }, dir)[
        'deployment.environment.name'
      ],
    ).toBeUndefined();
    expect(buildResourceAttributes({ OTEL_SERVICE_NAME: 'from-env' }, dir)['service.name']).toBe('from-env');
  });

  it('tolerates missing package.json', () => {
    expect(() => buildResourceAttributes({}, '/nonexistent')).not.toThrow();
    expect(buildResourceAttributes({}, '/nonexistent')).toEqual({});
  });

  it('tolerates invalid package.json', () => {
    const bad = mkdtempSync(join(tmpdir(), 'otel-res-bad-'));
    writeFileSync(join(bad, 'package.json'), '{not json');
    try {
      expect(buildResourceAttributes({}, bad)).toEqual({});
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });
});
