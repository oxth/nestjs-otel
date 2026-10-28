import {
  InstrumentationBase,
  type InstrumentationConfig,
  InstrumentationNodeModuleDefinition,
} from '@opentelemetry/instrumentation';
import { PACKAGE_VERSION } from '../shared/constants';
import { safely } from '../shared/safe';
import { toDbSystemName } from './db-system';
import { type OrmCall, isInsideOrmLeaf, runOrmSpan } from './orm-span';
import { type MethodWrapper, patchMethods, unpatchMethods } from './patch';

export const TYPEORM_MANAGER_METHODS: readonly string[] = [
  // reads
  'find',
  'findBy',
  'findOne',
  'findOneBy',
  'findOneOrFail',
  'findOneByOrFail',
  'findByIds', // 0.3 only
  'findOneById', // 0.3 only
  'preload',
  'findAndCount',
  'findAndCountBy',
  'count',
  'countBy',
  'exists',
  'existsBy',
  'sum',
  'average',
  'minimum',
  'maximum',
  // writes
  'save',
  'insert',
  'update',
  'upsert',
  'delete',
  'softDelete',
  'restore',
  'remove',
  'softRemove',
  'recover',
  'updateAll',
  'deleteAll',
  'increment',
  'decrement',
  'clear',
  // raw
  'query',
  // container
  'transaction',
];

export const TYPEORM_SELECT_QB_METHODS: readonly string[] = [
  'getMany',
  'getOne',
  'getOneOrFail',
  'getRawMany',
  'getRawOne',
  'getManyAndCount',
  'getRawAndEntities',
  'getCount',
  'getExists',
];

/** Operation name used for each write query builder's `execute`. */
const WRITE_QB_OPERATIONS: Record<string, string> = {
  InsertQueryBuilder: 'insert',
  UpdateQueryBuilder: 'update',
  DeleteQueryBuilder: 'delete',
  SoftDeleteQueryBuilder: 'softDelete',
};

export const TYPEORM_WRITE_QB_CLASSES: readonly string[] = Object.keys(WRITE_QB_OPERATIONS);

const EXECUTE = ['execute'] as const;

/**
 * Methods that also accept an entity instance (or array) without an explicit target. Like TypeORM,
 * the first argument is a target only when more than one argument is given.
 */
const INSTANCE_FORM = new Set(['save', 'remove', 'softRemove', 'recover']);

const protoOf = (moduleExports: any, name: string): object | undefined =>
  safely(`typeorm ${name}`, () => moduleExports?.[name]?.prototype, undefined);

/** The data source of an EntityManager / QueryBuilder (`dataSource` in 1.x, `connection` in 0.3). */
function dataSourceOf(self: any): any {
  return self?.dataSource ?? self?.connection;
}

function systemOf(self: any): string | undefined {
  return safely('typeorm system', () => toDbSystemName(dataSourceOf(self)?.options?.type), undefined);
}

function isEntitySchema(moduleExports: any, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const checker = moduleExports?.InstanceChecker?.isEntitySchema;
  if (typeof checker === 'function') return checker.call(moduleExports.InstanceChecker, value) === true;
  const Schema = moduleExports?.EntitySchema;
  return typeof Schema === 'function' && value instanceof Schema;
}

function isTarget(moduleExports: any, value: unknown): boolean {
  return typeof value === 'function' || typeof value === 'string' || isEntitySchema(moduleExports, value);
}

function fallbackName(target: any): string | undefined {
  if (typeof target === 'string') return target;
  if (typeof target === 'function') return target === Object ? undefined : target.name || undefined;
  const name = target?.options?.name;
  return typeof name === 'string' ? name : undefined;
}

function describeTarget(self: any, target: unknown): { entity?: string; collection?: string } {
  if (target === undefined || target === null) return {};
  const metadata = safely('typeorm metadata', () => dataSourceOf(self)?.getMetadata(target), undefined);
  const entity = safely('typeorm entity', () => metadata?.name ?? fallbackName(target), undefined);
  const collection = safely('typeorm table', () => metadata?.tableName, undefined);
  return {
    entity: typeof entity === 'string' ? entity : undefined,
    collection: typeof collection === 'string' ? collection : undefined,
  };
}

function managerCall(moduleExports: any, self: any, method: string, args: unknown[]): OrmCall {
  const base = { orm: 'typeorm' as const, operation: method, system: systemOf(self) };
  if (method === 'transaction') return { ...base, scope: 'container' };
  if (method === 'query') return { ...base, params: () => args[1] };

  const first = args[0];
  if (INSTANCE_FORM.has(method) && !(args.length > 1 && isTarget(moduleExports, first))) {
    const sample = Array.isArray(first) ? first[0] : first;
    const ctor = sample && typeof sample === 'object' ? (sample as object).constructor : undefined;
    return { ...base, ...describeTarget(self, ctor), params: () => args };
  }
  return { ...base, ...describeTarget(self, first), params: () => args.slice(1) };
}

function queryBuilderCall(self: any, operation: string): OrmCall {
  const metadata = safely('typeorm qb metadata', () => self?.expressionMap?.mainAlias?.metadata, undefined);
  const entity = safely('typeorm qb entity', () => metadata?.name, undefined);
  const collection = safely('typeorm qb table', () => metadata?.tableName, undefined);
  return {
    orm: 'typeorm',
    operation,
    entity: typeof entity === 'string' ? entity : undefined,
    collection: typeof collection === 'string' ? collection : undefined,
    system: systemOf(self),
    params: () => self.getParameters(),
  };
}

/**
 * Wraps `original` so each call runs inside an ORM span. Metadata extraction never throws;
 * the original is called exactly once with `this` and arguments unchanged.
 */
function traced(original: (...a: any[]) => any, describe: (self: any, args: unknown[]) => OrmCall | undefined) {
  return function (this: unknown, ...args: unknown[]) {
    if (isInsideOrmLeaf()) return original.apply(this, args);
    const call = safely('typeorm describe call', () => describe(this, args), undefined);
    if (!call) return original.apply(this, args);
    return runOrmSpan(call, () => original.apply(this, args));
  };
}

export function patchTypeorm(moduleExports: any): void {
  safely(
    'patch typeorm',
    () => {
      const manager: MethodWrapper = (original, name) =>
        traced(original, (self, args) => managerCall(moduleExports, self, name, args));
      patchMethods(protoOf(moduleExports, 'EntityManager'), TYPEORM_MANAGER_METHODS, manager);

      const select: MethodWrapper = (original, name) => traced(original, (self) => queryBuilderCall(self, name));
      patchMethods(protoOf(moduleExports, 'SelectQueryBuilder'), TYPEORM_SELECT_QB_METHODS, select);

      for (const cls of TYPEORM_WRITE_QB_CLASSES) {
        const operation = WRITE_QB_OPERATIONS[cls];
        patchMethods(protoOf(moduleExports, cls), EXECUTE, (original) =>
          traced(original, (self) => queryBuilderCall(self, operation)),
        );
      }
    },
    undefined,
  );
}

export function unpatchTypeorm(moduleExports: any): void {
  safely(
    'unpatch typeorm',
    () => {
      unpatchMethods(protoOf(moduleExports, 'EntityManager'), TYPEORM_MANAGER_METHODS);
      unpatchMethods(protoOf(moduleExports, 'SelectQueryBuilder'), TYPEORM_SELECT_QB_METHODS);
      for (const cls of TYPEORM_WRITE_QB_CLASSES) unpatchMethods(protoOf(moduleExports, cls), EXECUTE);
    },
    undefined,
  );
}

export class TypeormInstrumentation extends InstrumentationBase {
  constructor(config: InstrumentationConfig = {}) {
    super('@oxth/nestjs-otel/instrumentation-typeorm', PACKAGE_VERSION, config);
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition(
      'typeorm',
      ['>=0.3.0 <2'],
      (moduleExports) => {
        patchTypeorm(moduleExports);
        return moduleExports;
      },
      (moduleExports) => unpatchTypeorm(moduleExports),
    );
  }
}
