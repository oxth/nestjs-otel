import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION } from '../../src/shared/constants';
import { MikroOrmInstrumentation, mikroDriverType } from '../../src/orm/mikro-orm';
import { toDbSystemName } from '../../src/orm/db-system';

describe('MikroOrmInstrumentation', () => {
  it('declares its name and the core, sql and knex module definitions', () => {
    const inst = new MikroOrmInstrumentation();
    expect(inst.instrumentationName).toBe('@oxth/nestjs-otel/instrumentation-mikro-orm');
    expect(inst.instrumentationVersion).toBe(PACKAGE_VERSION);
    const defs = inst.getModuleDefinitions();
    expect(defs.map((d) => [d.name, d.supportedVersions])).toEqual([
      ['@mikro-orm/core', ['>=6.0.0 <8']],
      ['@mikro-orm/sql', ['>=7.0.0 <8']],
      ['@mikro-orm/knex', ['>=6.0.0 <7']],
    ]);
    inst.disable();
  });
});

describe('mikroDriverType', () => {
  class Platform {}
  class AbstractSqlPlatform extends Platform {}
  class BaseSqlitePlatform extends AbstractSqlPlatform {}
  class SqlitePlatform extends BaseSqlitePlatform {}
  class BetterSqlitePlatform extends BaseSqlitePlatform {}
  class BasePostgreSqlPlatform extends AbstractSqlPlatform {}
  class PgLitePlatform extends BasePostgreSqlPlatform {}
  class PostgreSqlPlatform extends BasePostgreSqlPlatform {}
  class MyCustomPlatform extends PostgreSqlPlatform {}
  class MongoPlatform extends Platform {}
  class MsSqlPlatform extends AbstractSqlPlatform {}

  it('maps the platform class (or its nearest known ancestor) to a db-system input', () => {
    expect(mikroDriverType(new SqlitePlatform())).toBe('sqlite');
    expect(mikroDriverType(new BetterSqlitePlatform())).toBe('better-sqlite');
    expect(mikroDriverType(new PgLitePlatform())).toBe('postgresql');
    expect(mikroDriverType(new MyCustomPlatform())).toBe('postgresql');
    expect(mikroDriverType(new MongoPlatform())).toBe('mongo');
    expect(mikroDriverType(new MsSqlPlatform())).toBe('mssql');
    expect(mikroDriverType(new Platform())).toBeUndefined();
    expect(mikroDriverType(undefined)).toBeUndefined();
    expect(toDbSystemName(mikroDriverType(new SqlitePlatform()))).toBe('sqlite');
  });
});
