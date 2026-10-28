import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION } from '../../src/shared/constants';
import { TypeormInstrumentation } from '../../src/orm/typeorm';

describe('TypeormInstrumentation', () => {
  it('declares its name and the typeorm module definition', () => {
    const inst = new TypeormInstrumentation();
    expect(inst.instrumentationName).toBe('@oxth/nestjs-otel/instrumentation-typeorm');
    expect(inst.instrumentationVersion).toBe(PACKAGE_VERSION);
    const defs = inst.getModuleDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('typeorm');
    expect(defs[0].supportedVersions).toEqual(['>=0.3.0 <2']);
    inst.disable();
  });

  it('PACKAGE_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
