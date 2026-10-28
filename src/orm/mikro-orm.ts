import {
  InstrumentationBase,
  type InstrumentationConfig,
  InstrumentationNodeModuleDefinition,
} from '@opentelemetry/instrumentation';
import { CENSOR, PACKAGE_VERSION } from '../shared/constants';
import { safely } from '../shared/safe';
import { toDbSystemName } from './db-system';
import { type OrmCall, isInsideOrmLeaf, runOrmSpan } from './orm-span';
import { type MethodWrapper, patchMethods, unpatchMethods } from './patch';

export const MIKRO_EM_METHODS: readonly string[] = [
  // reads
  'find',
  'findOne',
  'findOneOrFail',
  'findAll',
  'findAndCount',
  'findByCursor',
  'count',
  'populate',
  'refresh',
  // writes
  'insert',
  'insertMany',
  'nativeUpdate',
  'nativeDelete',
  'upsert',
  'upsertMany',
  'flush',
  // raw (only the SQL entity manager subclass has it; patched through the sql/knex package)
  'execute',
  // container
  'transactional',
  // leaves
  'begin',
  'commit',
  'rollback',
];

export const MIKRO_QB_METHODS: readonly string[] = [
  'execute',
  'getResult',
  'getResultList',
  'getSingleResult',
  'getCount',
  'getResultAndCount',
];

const RAW = ['execute'] as const;

/** Methods without an entity or parameters. */
const NO_TARGET = new Set(['flush', 'transactional', 'begin', 'commit', 'rollback']);

/** Platform class stems (lowercased, without `Base` / `Platform`) → `toDbSystemName` input. */
const PLATFORM_TYPES: Record<string, string> = {
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  mongo: 'mongo',
  sqlite: 'sqlite',
  bettersqlite: 'better-sqlite',
  libsql: 'libsql',
  mssql: 'mssql',
  oracle: 'oracle',
};

/**
 * The driver type of a MikroORM platform, from its class name or the nearest known ancestor's
 * (e.g. `SqlitePlatform` → `'sqlite'`, `PgLitePlatform extends BasePostgreSqlPlatform` → `'postgresql'`).
 * MikroORM 6/7 have no string driver type in their configuration.
 */
export function mikroDriverType(platform: unknown): string | undefined {
  let proto = platform && typeof platform === 'object' ? Object.getPrototypeOf(platform) : undefined;
  for (let depth = 0; proto && proto !== Object.prototype && depth < 10; depth++) {
    const name = proto.constructor?.name;
    if (typeof name === 'string') {
      const stem = name.replace(/Platform$/, '').replace(/^Base/, '').toLowerCase();
      if (Object.hasOwn(PLATFORM_TYPES, stem)) return PLATFORM_TYPES[stem];
    }
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

const protosOf = (moduleExports: any, names: readonly string[]): object[] =>
  safely(
    'mikro-orm prototypes',
    () => [...new Set(names.map((n) => moduleExports?.[n]?.prototype).filter(Boolean))] as object[],
    [],
  );

function systemOf(platform: unknown): string | undefined {
  return safely('mikro-orm system', () => toDbSystemName(mikroDriverType(platform)), undefined);
}

function isEntitySchema(coreExports: any, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const Schema = coreExports?.EntitySchema;
  if (typeof Schema !== 'function') return false;
  if (value instanceof Schema) return true;
  return typeof Schema.is === 'function' && Schema.is(value) === true;
}

function isTarget(coreExports: any, value: unknown): boolean {
  return typeof value === 'function' || typeof value === 'string' || isEntitySchema(coreExports, value);
}

function fallbackName(target: any): string | undefined {
  if (typeof target === 'string') return target;
  if (typeof target === 'function') return target === Object ? undefined : target.name || undefined;
  const name = target?.meta?.className ?? target?.name;
  return typeof name === 'string' ? name : undefined;
}

function describeTarget(self: any, target: unknown): { entity?: string; collection?: string } {
  if (target === undefined || target === null) return {};
  let meta: any;
  try {
    // Unknown targets are expected (find returns undefined, or a version throws): stay silent.
    meta = self?.getMetadata?.()?.find?.(target);
  } catch {
    meta = undefined;
  }
  const entity = safely('mikro-orm entity', () => meta?.className ?? fallbackName(target), undefined);
  const collection = safely('mikro-orm table', () => meta?.tableName ?? meta?.collection, undefined);
  return {
    entity: typeof entity === 'string' ? entity : undefined,
    collection: typeof collection === 'string' ? collection : undefined,
  };
}

function emCall(coreExports: any, self: any, method: string, args: unknown[]): OrmCall {
  const base = { orm: 'mikro-orm' as const, operation: method, system: systemOf(self?.getPlatform?.()) };
  if (method === 'transactional') return { ...base, scope: 'container' };
  if (NO_TARGET.has(method)) return base;
  if (method === 'execute') return { ...base, params: () => args[1] };

  const first = args[0];
  if (first && typeof first === 'object' && !isTarget(coreExports, first)) {
    // Instance form: insert(entity), upsertMany(entities), refresh(entity), populate(entities, …).
    const sample = Array.isArray(first) ? first[0] : first;
    const ctor = sample && typeof sample === 'object' ? (sample as object).constructor : undefined;
    return { ...base, ...describeTarget(self, ctor), params: () => args };
  }
  return { ...base, ...describeTarget(self, first), params: () => args.slice(1) };
}

/**
 * Query builder parameters for capture. `getParams()` is positional, so its values are always censored;
 * the keyed insert/update data and where condition are included instead so the redactor masks
 * sensitive fields. Internal fields: `state.data` / `state.cond` (v7), `_data` / `_cond` (v6).
 */
function queryBuilderParams(self: any): unknown {
  const state = self.state && typeof self.state === 'object' ? self.state : undefined;
  const data = state ? state.data : self._data;
  const where = state ? state.cond : self._cond;
  let params: unknown;
  try {
    const raw = self.getParams?.();
    params = Array.isArray(raw) ? raw.map(() => CENSOR) : raw === undefined ? undefined : CENSOR;
  } catch {
    // The query may not compile (that can be why the call failed): no positional params then.
    params = undefined;
  }
  const out: Record<string, unknown> = {};
  if (data !== undefined) out.data = data;
  if (where !== undefined) out.where = where;
  if (params !== undefined) out.params = params;
  return out;
}

function queryBuilderCall(self: any, operation: string): OrmCall {
  let alias: any;
  try {
    // v7 keeps it in `state`, v6 in `_mainAlias`; the `mainAlias` getter throws when unset.
    alias = self?.state?.mainAlias ?? self?._mainAlias ?? self?.mainAlias;
  } catch {
    alias = undefined;
  }
  const meta = safely('mikro-orm qb metadata', () => alias?.meta ?? alias?.metadata, undefined);
  const entity = safely(
    'mikro-orm qb entity',
    () => meta?.className ?? fallbackName(alias?.entityName ?? self?.entityName),
    undefined,
  );
  const collection = safely('mikro-orm qb table', () => meta?.tableName ?? meta?.collection, undefined);
  return {
    orm: 'mikro-orm',
    operation,
    entity: typeof entity === 'string' ? entity : undefined,
    collection: typeof collection === 'string' ? collection : undefined,
    system: systemOf(self?.platform ?? self?.driver?.getPlatform?.()),
    params: () => queryBuilderParams(self),
  };
}

/**
 * Wraps `original` so each call runs inside an ORM span. Metadata extraction never throws;
 * the original is called exactly once with `this` and arguments unchanged.
 */
function traced(original: (...a: any[]) => any, describe: (self: any, args: unknown[]) => OrmCall | undefined) {
  return function (this: unknown, ...args: unknown[]) {
    if (isInsideOrmLeaf()) return original.apply(this, args);
    const call = safely('mikro-orm describe call', () => describe(this, args), undefined);
    if (!call) return original.apply(this, args);
    return runOrmSpan(call, () => original.apply(this, args));
  };
}

const emWrapper =
  (coreExports: any): MethodWrapper =>
  (original, name) =>
    traced(original, (self, args) => emCall(coreExports, self, name, args));

/** Patches `EntityManager.prototype` from `@mikro-orm/core`; SQL/Mongo subclasses inherit it. */
export function patchMikroOrm(coreExports: any): void {
  safely(
    'patch mikro-orm',
    () => {
      for (const proto of protosOf(coreExports, ['EntityManager'])) {
        patchMethods(proto, MIKRO_EM_METHODS, emWrapper(coreExports));
      }
    },
    undefined,
  );
}

/**
 * Patches the SQL `QueryBuilder.prototype` and the SQL entity manager's own `execute`, from
 * `@mikro-orm/sql` (v7) or `@mikro-orm/knex` (v6).
 */
export function patchMikroQueryBuilder(sqlExports: any): void {
  safely(
    'patch mikro-orm query builder',
    () => {
      for (const proto of protosOf(sqlExports, ['QueryBuilder'])) {
        patchMethods(proto, MIKRO_QB_METHODS, (original, name) =>
          traced(original, (self) => queryBuilderCall(self, name)),
        );
      }
      for (const proto of protosOf(sqlExports, ['SqlEntityManager', 'EntityManager'])) {
        // Only its own `execute`: the inherited methods are patched on the core prototype.
        if (Object.hasOwn(proto, 'execute')) patchMethods(proto, RAW, emWrapper(sqlExports));
      }
    },
    undefined,
  );
}

export function unpatchMikroOrm(coreExports: any): void {
  safely(
    'unpatch mikro-orm',
    () => {
      for (const proto of protosOf(coreExports, ['EntityManager'])) unpatchMethods(proto, MIKRO_EM_METHODS);
    },
    undefined,
  );
}

export function unpatchMikroQueryBuilder(sqlExports: any): void {
  safely(
    'unpatch mikro-orm query builder',
    () => {
      for (const proto of protosOf(sqlExports, ['QueryBuilder'])) unpatchMethods(proto, MIKRO_QB_METHODS);
      for (const proto of protosOf(sqlExports, ['SqlEntityManager', 'EntityManager'])) {
        if (Object.hasOwn(proto, 'execute')) unpatchMethods(proto, RAW);
      }
    },
    undefined,
  );
}

export class MikroOrmInstrumentation extends InstrumentationBase {
  constructor(config: InstrumentationConfig = {}) {
    super('@oxth/nestjs-otel/instrumentation-mikro-orm', PACKAGE_VERSION, config);
  }

  protected init() {
    const sqlDefinition = (name: string, versions: string[]) =>
      new InstrumentationNodeModuleDefinition(
        name,
        versions,
        (moduleExports) => {
          patchMikroQueryBuilder(moduleExports);
          return moduleExports;
        },
        (moduleExports) => unpatchMikroQueryBuilder(moduleExports),
      );
    return [
      new InstrumentationNodeModuleDefinition(
        '@mikro-orm/core',
        ['>=6.0.0 <8'],
        (moduleExports) => {
          patchMikroOrm(moduleExports);
          return moduleExports;
        },
        (moduleExports) => unpatchMikroOrm(moduleExports),
      ),
      sqlDefinition('@mikro-orm/sql', ['>=7.0.0 <8']),
      sqlDefinition('@mikro-orm/knex', ['>=6.0.0 <7']),
    ];
  }
}
