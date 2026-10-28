import { describe, expect, it } from 'vitest';
import { toDbSystemName } from '../../src/orm/db-system';

describe('toDbSystemName', () => {
  it.each([
    ['postgres', 'postgresql'], ['cockroachdb', 'postgresql'], ['mysql', 'mysql'], ['mariadb', 'mariadb'],
    ['mongodb', 'mongodb'], ['sqlite', 'sqlite'], ['better-sqlite3', 'sqlite'], ['sqljs', 'sqlite'],
    ['capacitor', 'sqlite'], ['expo', 'sqlite'], ['mssql', 'microsoft.sql_server'], ['oracle', 'oracle.db'],
    ['spanner', 'gcp.spanner'], ['postgresql', 'postgresql'], ['mongo', 'mongodb'], ['better-sqlite', 'sqlite'],
    ['libsql', 'sqlite'], ['nope', undefined], ['toString', undefined], [undefined, undefined],
  ])('%s -> %s', (i, o) => expect(toDbSystemName(i as string | undefined)).toBe(o));
});
