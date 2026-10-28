const MAP: Record<string, string> = {
  postgres: 'postgresql',
  cockroachdb: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  mongodb: 'mongodb',
  mongo: 'mongodb',
  sqlite: 'sqlite',
  'better-sqlite3': 'sqlite',
  'better-sqlite': 'sqlite',
  libsql: 'sqlite',
  sqljs: 'sqlite',
  capacitor: 'sqlite',
  expo: 'sqlite',
  mssql: 'microsoft.sql_server',
  oracle: 'oracle.db',
  spanner: 'gcp.spanner',
};

export function toDbSystemName(driverType: string | undefined): string | undefined {
  if (!driverType) return undefined;
  return Object.hasOwn(MAP, driverType) ? MAP[driverType] : undefined;
}
