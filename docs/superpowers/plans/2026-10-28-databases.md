# @oxth/nestjs-otel — Plan 2: Databases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In an app using TypeORM or MikroORM, every ORM call shows up as a span (`TypeORM find User`) with the driver's SQL/Mongo span beneath it. Query values never leak into spans, the ORM call's parameters are attached (redacted) only when it fails, and the driver instrumentations' DB metrics are exported.

**Architecture:**
- **Driver layer:** the `pg`, `mysql2`, and `mongodb` OTel instrumentations are added to the existing bootstrap registry. Their settings mask literal values.
- **ORM layer:** the library's own `InstrumentationBase` subclasses patch the ORM classes' **prototypes** when the module loads. This uses the same require/import hooks as every other instrumentation, so it works without `OtelModule` and in both CJS and ESM.
- **Shared runner:** both ORMs use one `runOrmSpan` runner. It handles span creation, suppression of nested ORM spans, error recording, and parameter capture.
- **Settings:** come from `OtelModule.forRoot({ db })` through the `globalThis` state, with defaults when the module isn't used.

**Tech Stack:** existing Plan 1 stack, plus `@opentelemetry/instrumentation-pg` 0.77, `-mysql2` 0.70, `-mongodb` 0.77, TypeORM `>=0.3.0 <2` (dev: 1.1.x), MikroORM `>=6 <8` (dev: 7.2.x), `sql.js` and `better-sqlite3` (in-process tests), `testcontainers` 12 (Docker DB tests).

**Spec:** `docs/superpowers/specs/2026-10-28-nestjs-otel-design.md` (§5.4 redaction of DB parameters, §5.5 DB metrics, §6 TypeORM/MikroORM rows). Plan 1 is merged on `main`. Read `README.md` and `src/` for current names.

## Global Constraints

- All Plan 1 Global Constraints still apply (`docs/superpowers/plans/2026-10-28-core.md`): telemetry never throws into app code (`safely`), the scope name is `@oxth/nestjs-otel`, config comes only from standard env vars, and the censor is `[REDACTED]`.
- **Supported versions** (optional peer dependencies): `typeorm >=0.3.0 <2`, `@mikro-orm/core >=6.0.0 <8`. An instrumentation applies only within its declared version range. Outside it, it does nothing; no errors.
- **Instrumentation names**, usable in `OTEL_NODE_ENABLED_INSTRUMENTATIONS` / `OTEL_NODE_DISABLED_INSTRUMENTATIONS`: `pg`, `mysql2`, `mongodb`, `typeorm`, `mikro-orm`.
- **Values never in clear by default:**
  - `pg`: `enhancedDatabaseReporting: false`, plus literal masking of the query text.
  - `mysql2`: `maskStatement: true`.
  - `mongodb`: `enhancedDatabaseReporting: false`.
- **ORM span shape:**
  - Kind INTERNAL. Name `${ormLabel} ${operation}${entity ? ' ' + entity : ''}`, where `ormLabel` is `TypeORM` or `MikroORM`. Examples: `TypeORM find User`, `MikroORM flush`.
  - Attributes: `db.orm.name` (`typeorm` | `mikro-orm`), `db.operation.name`, `db.orm.entity` (entity class or schema name, when known), `db.collection.name` (table or collection, when known), `db.system.name` (see `db-system.ts`).
- **ORM parameters:** the attribute is `db.orm.params` (the redacted, serialized call arguments), with `db.orm.params.truncated=true` when truncated.
  - The default capture mode is `'error'`: parameters are attached only when the ORM call fails, which matches the author's "bodies on failed requests only" decision.
  - Default limit: `2048` bytes.
- **One ORM span per user call:** an ORM call made *inside* another ORM span is a pass-through (no new span). The exception is **container** operations (`transaction` / `transactional`), whose callbacks' ORM calls are traced as children.
- **Never wrap streaming APIs.** TypeORM `stream`, and MikroORM `stream` and cursor iteration, are left untouched.

## Review Focus

1. **Nested ORM calls:** TypeORM `findOne` calls `getOne` internally, MikroORM `find` runs a QueryBuilder, and `save` runs several queries. Each must give exactly one ORM span, with driver spans as its children. Calls inside `manager.transaction(cb)` / `em.transactional(cb)` must still get their own spans under the transaction span. Test: Task 3 `nested ORM calls produce one span` and `transaction callback calls are traced as children`; Task 4 likewise.
2. **A secret value in a keyed ORM write** (for example `password`) must never appear in any exported span attribute (pg, mysql2, mongodb, ORM span) when the write succeeds, and must appear only as `[REDACTED]` when it fails. Raw positional `query` parameters on failure are the documented exception. Test: Task 6 `secret never leaks` for each scenario.
3. **ESM-only MikroORM 7** is loaded both from an ESM app and from a CJS app (through `require(esm)`), and both get ORM spans. Test: Task 6 runs the `mikro-orm-pg` scenario with the `esm` and `cjs` entries.
4. **An ORM version missing some methods** must not crash. Methods that don't exist are skipped silently. Test: Task 3 and Task 4 `skips absent methods`.
5. **Streams and cursors still work unchanged:** TypeORM `createQueryBuilder().stream()` and MikroORM `em.stream()` (where the version has it). Test: Task 3 `stream is untouched`, and Task 4 likewise when the installed version supports it.

## File Structure

```
src/
  shared/global-state.ts       + db?: DbSettings; redactor?: Redactor   (modify)
  redact/redactor.ts           getDefaultRedactor/setDefaultRedactor backed by global state (modify)
  redact/sql-mask.ts           maskSqlLiterals
  orm/settings.ts              DbSettings, resolveDbSettings, getDbSettings, setDbSettings
  orm/db-system.ts             toDbSystemName
  orm/orm-span.ts              runOrmSpan, ORM_SCOPE context key
  orm/patch.ts                 patchMethods / unpatchMethods (prototype patching helper)
  orm/typeorm.ts               patchTypeorm, unpatchTypeorm, TypeormInstrumentation
  orm/mikro-orm.ts             patchMikroOrm, patchMikroQueryBuilder, unpatch*, MikroOrmInstrumentation
  bootstrap/config.ts          InstrumentationName union += pg|mysql2|mongodb|typeorm|mikro-orm (modify)
  bootstrap/detect.ts          ADAPTER_PACKAGES values become string[]; db adapters added (modify)
  bootstrap/instrumentations.ts  + 5 entries (modify)
  module/options.ts            + db options (modify)
  module/otel.module.ts        setDbSettings(resolved.db) (modify)
  index.ts                     export DbCaptureMode type (modify)
test/
  unit/sql-mask.test.ts, unit/db-settings.test.ts, unit/db-system.test.ts
  unit/instrumentations.test.ts (modify)
  integration/orm-span.test.ts
  integration/typeorm.test.ts          sql.js, in-process
  integration/mikro-orm.test.ts        better-sqlite3, in-process
  db/global-setup.ts                   testcontainers: postgres, mysql, mongo; then e2e fixture setup
  db/helpers/containers.ts
  db/orm.db.test.ts
  e2e/fixture/src/db/…                 DB modules for the fixture (selected by env DB)
vitest.db.config.ts
.github/workflows/ci.yml (modify)  README.md (modify)
```

---

### Task 1: Shared DB settings, global redactor, and SQL literal masking

**Files:**
- Create: `src/redact/sql-mask.ts`, `src/orm/settings.ts`, `src/orm/db-system.ts`
- Modify: `src/shared/global-state.ts`, `src/redact/redactor.ts`, `src/module/options.ts`, `src/module/otel.module.ts`, `src/index.ts`
- Test: `test/unit/sql-mask.test.ts`, `test/unit/db-settings.test.ts`, `test/unit/db-system.test.ts`, `test/integration/otel-module.test.ts` (modify)

**Interfaces:**
- Produces:
```ts
// sql-mask.ts
export function maskSqlLiterals(sql: string): string;
// replaces quoted string literals ('…', "…", with escapes) and standalone numbers (\b\d+(\.\d+)?\b) with '?';
// leaves $1/:name/? placeholders and identifiers (incl. "quoted_identifiers" when followed by '.'/as column refs — see tests) as-is
// settings.ts
export type DbCaptureMode = 'error' | 'always' | 'never';
export interface DbOptions { captureParams?: DbCaptureMode; maxParamsBytes?: number }
export interface DbSettings { captureParams: DbCaptureMode; maxParamsBytes: number }
export function resolveDbSettings(o?: DbOptions): DbSettings;     // defaults 'error', 2048
export function getDbSettings(): DbSettings;                       // global state value or defaults
export function setDbSettings(s: DbSettings): void;
// db-system.ts
export function toDbSystemName(driverType: string | undefined): string | undefined;
// typeorm types: postgres|cockroachdb→postgresql, mysql→mysql, mariadb→mariadb, mongodb→mongodb, sqlite|better-sqlite3|sqljs|capacitor|expo→sqlite,
// mssql→microsoft.sql_server, oracle→oracle.db, spanner→gcp.spanner; mikro platform/driver names: postgresql→postgresql, mysql→mysql, mariadb→mariadb,
// mongo|mongodb→mongodb, sqlite|better-sqlite|libsql→sqlite, mssql→microsoft.sql_server; unknown→undefined
```
- Change: `OtelModuleOptions.db?: DbOptions`, and `ResolvedOtelOptions.db: DbSettings`. `OtelModule` calls `setDbSettings(resolved.db)` in the same place it calls `setDefaultRedactor`.
- Change: `getDefaultRedactor` / `setDefaultRedactor` store the redactor in `getGlobalState().redactor`, so the ESM `register` copy and the CJS index copy share it. This fixes Plan 1's deferred finding "two-copy FATAL log uses default redactor". Signatures stay the same.

**Decision (the plan's call):** `maskSqlLiterals` uses the same rule as the `mysql2` instrumentation's default `maskStatementHook`: numbers and quoted strings become `?`. A side effect is that `LIMIT 10` becomes `LIMIT ?`. There is no option to turn it off in Plan 2 (YAGNI).

**Note on double quotes:** in PostgreSQL, `"…"` is an *identifier*, not a string. Mask only single-quoted strings for `pg`, using `maskSqlLiterals(sql, { doubleQuotedStrings: false })`. Add that second parameter: `opts?: { doubleQuotedStrings?: boolean }`, default true. mysql2 keeps its own hook.

- [ ] **Step 1: Write the failing tests**

```ts
// sql-mask.test.ts
it('masks single-quoted strings and numbers', () => {
  expect(maskSqlLiterals("SELECT * FROM u WHERE pw = 'hunter2' AND id = 42 LIMIT 10"))
    .toBe('SELECT * FROM u WHERE pw = ? AND id = ? LIMIT ?');
});
it('handles escaped quotes', () => expect(maskSqlLiterals("x = 'it''s'")).toBe('x = ?'));
it('keeps placeholders and identifiers with digits', () => {
  expect(maskSqlLiterals('SELECT "t1"."col2" FROM t1 WHERE a = $1 AND b = :name AND c = ?', { doubleQuotedStrings: false }))
    .toBe('SELECT "t1"."col2" FROM t1 WHERE a = $1 AND b = :name AND c = ?');
});
it('double-quoted strings masked when enabled', () => expect(maskSqlLiterals('x = "secret"')).toBe('x = ?'));
// db-settings.test.ts
it('defaults', () => expect(resolveDbSettings()).toEqual({ captureParams: 'error', maxParamsBytes: 2048 }));
it('getDbSettings falls back to defaults and reads global state', () => {
  expect(getDbSettings().captureParams).toBe('error');
  setDbSettings({ captureParams: 'always', maxParamsBytes: 10 });
  expect((globalThis as any)[Symbol.for('@oxth/nestjs-otel.state')].db.captureParams).toBe('always');
});
it('default redactor lives in global state', () => {
  const r = createRedactor({ keys: ['zzz'] }); setDefaultRedactor(r);
  expect((globalThis as any)[Symbol.for('@oxth/nestjs-otel.state')].redactor).toBe(r);
});
// db-system.test.ts: table test over the mapping above, including unknown → undefined.
// otel-module.test.ts (add)
it('forRoot({ db }) sets global db settings', ...);   // OtelModule.forRoot({ db: { captureParams: 'never' } }) → getDbSettings().captureParams === 'never'
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run test/unit/sql-mask.test.ts test/unit/db-settings.test.ts test/unit/db-system.test.ts test/integration/otel-module.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run them and confirm they pass**

Run: same command as Step 2, then the full `pnpm vitest run`.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add db settings, global redactor and sql literal masking"
```

---

### Task 2: The ORM span runner and the prototype patch helper

**Files:**
- Create: `src/orm/orm-span.ts`, `src/orm/patch.ts`
- Test: `test/integration/orm-span.test.ts`

**Interfaces:**
- Consumes: `runInSpan` and `handleResult` (`src/tracing/wrap.ts`), `recordError` and `getClassifyDefaults` (from tracing decorators), `getDefaultRedactor`, `serializeBody`, `getDbSettings`, `safely`, `SCOPE_NAME`.
- Produces:
```ts
export type OrmScope = 'leaf' | 'container';
export interface OrmCall {
  orm: 'typeorm' | 'mikro-orm';
  operation: string;                 // e.g. 'find', 'flush', 'getMany', 'execute'
  entity?: string;
  collection?: string;
  system?: string;                   // db.system.name
  params?: () => unknown;            // lazily evaluated; only called when capture applies
  scope?: OrmScope;                  // default 'leaf'
}
export function runOrmSpan<T>(call: OrmCall, fn: () => T): T;
export function isInsideOrmLeaf(): boolean;   // true when the active context carries a 'leaf' ORM scope
// patch.ts
export type MethodWrapper = (original: (...a: any[]) => any, methodName: string) => (...a: any[]) => any;
export function patchMethods(proto: object | undefined, methods: readonly string[], wrapper: MethodWrapper): string[]; // returns patched names; skips absent/non-function/already patched
export function unpatchMethods(proto: object | undefined, methods: readonly string[]): void;
```

**`runOrmSpan` behavior:**
- If `isInsideOrmLeaf()`: return `fn()` directly. No span, no telemetry.
- Otherwise start an INTERNAL span with the name and attributes from Global Constraints.
- Put `{ scope }` in the context under a private `createContextKey('@oxth/nestjs-otel.orm-scope')`, then run `fn` in that context. Settle sync, Promise, and Observable results through `handleResult`, and end the span exactly once.
- **On error:**
  - `recordError(span, err, getClassifyDefaults())`, called through `safely`.
  - If `captureParams !== 'never'`, attach `db.orm.params` = `serializeBody(getDefaultRedactor().redact(call.params()), maxParamsBytes).body`, and `db.orm.params.truncated=true` when it was truncated.
- **On success:** attach the params only when `captureParams === 'always'`.
- The user error is re-thrown unchanged, and `fn` is called exactly once (use the `runInSpan` guarantees).
- **`patchMethods`:** marks each wrapper with `Symbol.for('@oxth/nestjs-otel.orm-original')`, pointing to the original. That makes patching idempotent and lets `unpatchMethods` restore it. The wrapper keeps `this`, and copies `name` and `length` (use `copyMethodMetadata`).

- [ ] **Step 1: Write the failing tests**

Use `setupInMemoryTracing()`.

```ts
it('creates span with name and attributes', async () => {
  await runOrmSpan({ orm: 'typeorm', operation: 'find', entity: 'User', collection: 'users', system: 'postgresql' }, async () => 1);
  const [s] = t.spans();
  expect(s.name).toBe('TypeORM find User'); expect(s.kind).toBe(SpanKind.INTERNAL);
  expect(s.attributes).toMatchObject({ 'db.orm.name': 'typeorm', 'db.operation.name': 'find', 'db.orm.entity': 'User', 'db.collection.name': 'users', 'db.system.name': 'postgresql' });
});
it('nested leaf call is a pass-through', async () => {
  await runOrmSpan({ orm: 'typeorm', operation: 'findOne', entity: 'User' }, () => runOrmSpan({ orm: 'typeorm', operation: 'getOne' }, async () => 1));
  expect(t.spans().map(s => s.name)).toEqual(['TypeORM findOne User']);
});
it('calls inside a container get their own child spans', async () => {
  await runOrmSpan({ orm: 'mikro-orm', operation: 'transactional', scope: 'container' }, () => runOrmSpan({ orm: 'mikro-orm', operation: 'flush' }, async () => 1));
  const [child, parent] = t.spans();
  expect(child.name).toBe('MikroORM flush'); expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
});
it('error: records exception, attaches redacted params, rethrows same error', async () => {
  const e = new Error('dup');
  await expect(runOrmSpan({ orm: 'typeorm', operation: 'save', entity: 'User', params: () => [{ email: 'a@b.c', password: 'hunter2' }] }, async () => { throw e; })).rejects.toBe(e);
  const [s] = t.spans();
  expect(s.status.code).toBe(SpanStatusCode.ERROR);
  expect(JSON.parse(s.attributes['db.orm.params'] as string)).toEqual([{ email: 'a@b.c', password: '[REDACTED]' }]);
});
it('success: no params by default; params with captureParams always; none with never', ...);
it('params thunk not called unless captured', ...);              // spy on thunk
it('params over maxParamsBytes are truncated and flagged', ...);
it('a throwing params thunk never affects the call', ...);
it('patchMethods skips absent methods, is idempotent, unpatch restores', () => {
  class A { find() { return 1; } }
  const w: MethodWrapper = (orig) => function (this: any, ...a) { return orig.apply(this, a) + 1; };
  expect(patchMethods(A.prototype, ['find', 'missing'], w)).toEqual(['find']);
  expect(patchMethods(A.prototype, ['find'], w)).toEqual([]);
  expect(new A().find()).toBe(2);
  unpatchMethods(A.prototype, ['find']); expect(new A().find()).toBe(1);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run test/integration/orm-span.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `runOrmSpan`, `isInsideOrmLeaf`, `patchMethods`, and `unpatchMethods`**

- [ ] **Step 4: Run them and confirm they pass**

Run: `pnpm vitest run test/integration/orm-span.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orm test/integration/orm-span.test.ts && git commit -m "feat: add shared ORM span runner and prototype patch helper"
```

---

### Task 3: TypeORM instrumentation

**Files:**
- Create: `src/orm/typeorm.ts`
- Modify: `package.json` (dev deps `typeorm@^1.1.2` and `sql.js`; optional peer `typeorm: ">=0.3.0 <2"`)
- Test: `test/integration/typeorm.test.ts`

**Interfaces:**
- Consumes: `runOrmSpan`, `patchMethods`, `unpatchMethods`, `toDbSystemName`.
- Produces:
```ts
export const TYPEORM_MANAGER_METHODS: readonly string[];  // see below
export const TYPEORM_SELECT_QB_METHODS: readonly string[];
export const TYPEORM_WRITE_QB_CLASSES: readonly string[]; // export names whose prototype.execute is patched
export function patchTypeorm(moduleExports: any): void;    // idempotent
export function unpatchTypeorm(moduleExports: any): void;
export class TypeormInstrumentation extends InstrumentationBase { constructor(config?: InstrumentationConfig) }
// instrumentationName '@oxth/nestjs-otel/instrumentation-typeorm'; module definition name 'typeorm', supportedVersions ['>=0.3.0 <2']
```

**What gets patched** (all taken from the `typeorm` main export; absent names are skipped):
- **`EntityManager.prototype`:**
  - Reads: `find`, `findBy`, `findOne`, `findOneBy`, `findOneOrFail`, `findOneByOrFail`, `findAndCount`, `findAndCountBy`, `count`, `countBy`, `exists`, `existsBy`, `sum`, `average`, `minimum`, `maximum`.
  - Writes: `save`, `insert`, `update`, `upsert`, `delete`, `softDelete`, `restore`, `remove`, `softRemove`, `increment`, `decrement`, `clear`.
  - Raw: `query`.
  - Container: `transaction`.
- **`SelectQueryBuilder.prototype`:** `getMany`, `getOne`, `getOneOrFail`, `getRawMany`, `getRawOne`, `getManyAndCount`, `getRawAndEntities`, `getCount`, `getExists`.
- **`.prototype.execute`** of `InsertQueryBuilder`, `UpdateQueryBuilder`, `DeleteQueryBuilder`, and `SoftDeleteQueryBuilder`.
- **Not patched:** `Repository`, which delegates to its `manager`, so its calls are already covered once; and `stream`.

**Per-call metadata:**
- **EntityManager:** the first argument is the target: an entity class (use `.name`), an `EntitySchema` (use `.options.name`), or a string.
  - Resolve metadata with `safely(() => this.connection.getMetadata(target))` to get `.name` (entity) and `.tableName` (collection).
  - For `save`/`remove`/`softRemove` called with an entity instance or array, use the instance's constructor.
  - `system` = `toDbSystemName(this.connection.options.type)`.
  - `params` = `() => args.slice(1)`, but for instance-only `save`/`remove`, `() => args`.
  - `query`: entity undefined, `params: () => args[1]`.
- **QueryBuilder:** `entity` = `this.expressionMap.mainAlias?.metadata?.name`, `collection` = `…metadata?.tableName`, `system` from `this.connection.options.type`, `params: () => this.getParameters()`.
- **`transaction`:** `scope: 'container'`, no params.

**`TypeormInstrumentation`:** `init()` returns `new InstrumentationNodeModuleDefinition('typeorm', ['>=0.3.0 <2'], exports => (patchTypeorm(exports), exports), exports => unpatchTypeorm(exports))`. TypeORM's `index.mjs` re-exports the CJS build, so the class objects are shared. Check this in Task 6's ESM run.

- [ ] **Step 1: Write the failing tests**

In-process: `import * as typeorm from 'typeorm'`, then `patchTypeorm(typeorm)` in `beforeAll` and `unpatchTypeorm` in `afterAll`. Use a `DataSource({ type: 'sqljs', entities: [UserSchema], synchronize: true })` with an `EntitySchema` named `User`, table `users`, and columns `id`, `email`, `password`.

```ts
it('repository find → one span "TypeORM find User" with table and system', async () => {
  await ds.getRepository('User').find({ where: { email: 'a@b.c' } });
  const s = only('TypeORM find User');
  expect(s.attributes).toMatchObject({ 'db.collection.name': 'users', 'db.system.name': 'sqlite', 'db.orm.name': 'typeorm' });
  expect(s.attributes['db.orm.params']).toBeUndefined();
});
it('nested ORM calls produce one span', async () => {   // findOne internally builds a SelectQueryBuilder.getOne
  await ds.manager.findOne('User', { where: { id: 1 } });
  expect(t.spans().filter(s => s.attributes['db.orm.name'] === 'typeorm')).toHaveLength(1);
});
it('transaction callback calls are traced as children', async () => {
  await ds.manager.transaction(async (m) => { await m.save('User', { email: 'x', password: 'p' }); });
  const tx = only('TypeORM transaction'); const save = only('TypeORM save User');
  expect(save.parentSpanContext?.spanId).toBe(tx.spanContext().spanId);
});
it('query builder getMany traced with entity and no params on success', ...);
it('insert query builder execute traced', ...);
it('failure attaches redacted params and records exception', async () => {
  await expect(ds.manager.query('SELECT * FROM nope WHERE password = ?', ['hunter2'])).rejects.toThrow();
  const s = only('TypeORM query');
  expect(s.status.code).toBe(SpanStatusCode.ERROR);
  expect(s.attributes['db.orm.params']).toBe('["hunter2"]');   // positional params have no keys → value kept; documented (see README task)
});
it('failure with keyed params redacts sensitive keys', async () => {   // save with unique violation or invalid column
  // e.g. ds.manager.insert('User', { id: 1, email: 'dup', password: 'hunter2' }) twice → second fails
  expect(JSON.parse(only('TypeORM insert User').attributes['db.orm.params'] as string)).toEqual([{ id: 1, email: 'dup', password: '[REDACTED]' }]);
});
it('stream is untouched', ...);           // createQueryBuilder().stream() is not patched (no orm-original marker); sql.js may not support stream → assert marker absence on SelectQueryBuilder.prototype.stream
it('skips absent methods', () => { const fake = { EntityManager: class { find() {} } }; expect(() => patchTypeorm(fake)).not.toThrow(); });
it('patchTypeorm is idempotent', ...);    // patch twice → still one span per call
```

**Positional parameters (the plan's call):** positional parameters (raw `query(sql, [values])`) have no keys, so the key-based redactor can't mask them. They are captured only on failure (the default mode) and pass only through the redactor's value patterns (JWT/Bearer). The README must say so. Review Focus 2 covers keyed ORM calls; raw positional parameters on failure are the documented exception.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run test/integration/typeorm.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `typeorm.ts`**

- [ ] **Step 4: Run them and confirm they pass**

Run: `pnpm vitest run test/integration/typeorm.test.ts`, then the full suite.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add TypeORM instrumentation"
```

---

### Task 4: MikroORM instrumentation

**Files:**
- Create: `src/orm/mikro-orm.ts`
- Modify: `package.json` (dev deps `@mikro-orm/core@^7.2.5` and `@mikro-orm/sqlite@^7.2.5`; optional peer `@mikro-orm/core: ">=6.0.0 <8"`; add `"pnpm": { "onlyBuiltDependencies": ["better-sqlite3"] }` so the native build runs)
- Test: `test/integration/mikro-orm.test.ts`

**Interfaces:**
- Produces:
```ts
export const MIKRO_EM_METHODS: readonly string[];
export const MIKRO_QB_METHODS: readonly string[];
export function patchMikroOrm(coreExports: any): void;           // EntityManager.prototype from @mikro-orm/core
export function patchMikroQueryBuilder(sqlExports: any): void;   // QueryBuilder.prototype from @mikro-orm/sql (v7) or @mikro-orm/knex (v6)
export function unpatchMikroOrm(coreExports: any): void;
export function unpatchMikroQueryBuilder(sqlExports: any): void;
export class MikroOrmInstrumentation extends InstrumentationBase { constructor(config?: InstrumentationConfig) }
// instrumentationName '@oxth/nestjs-otel/instrumentation-mikro-orm'; definitions:
//   '@mikro-orm/core' ['>=6.0.0 <8'], '@mikro-orm/sql' ['>=7.0.0 <8'], '@mikro-orm/knex' ['>=6.0.0 <7']
```

**What gets patched** (absent names are skipped):
- **`EntityManager.prototype`:**
  - Reads: `find`, `findOne`, `findOneOrFail`, `findAll`, `findAndCount`, `findByCursor`, `count`, `populate`, `refresh`.
  - Writes: `insert`, `insertMany`, `nativeUpdate`, `nativeDelete`, `upsert`, `upsertMany`, `flush`.
  - Raw: `execute` (when present on the SQL entity manager subclass: patch the subclass prototype exported from the sql/knex package as `SqlEntityManager` / `EntityManager`).
  - Container: `transactional`. Leaves: `begin`, `commit`, `rollback`.
- **QueryBuilder:** `execute`, `getResult`, `getResultList`, `getSingleResult`, `getCount`, `getResultAndCount`.
- **Not patched:** `EntityRepository`, which delegates to the em; `stream`; `persist`/`remove`, which are sync and do no I/O.

**Per-call metadata:**
- **Entity:** the first argument is the entity name (class, string, or `EntitySchema`). Resolve with `safely(() => this.getMetadata().find(name))` → `.className` (entity), `.tableName` or `.collection` (collection).
- **`system`:** `toDbSystemName(this.getPlatform?.().constructor.name …)`. The implementer picks the most reliable source in the installed version (for example `this.config.get('driver')` name, or `platform.getConfig()`). Unit-test the mapping input it produces for sqlite.
- **`params`:** `() => args.slice(1)`. For `flush`: no params (entity, collection, and params all undefined).
- **QueryBuilder:** `entity` = `this.mainAlias?.entityName` or `this.entityName`, `params: () => this.getParams?.()` (or the version's equivalent).
- **`transactional`:** `scope: 'container'`.

- [ ] **Step 1: Write the failing tests**

In-process: `patchMikroOrm(await import('@mikro-orm/core'))` and `patchMikroQueryBuilder(await import('@mikro-orm/sql'))`. Use `MikroORM.init({ driver: SqliteDriver, dbName: ':memory:', entities: [UserSchema] })` with an `EntitySchema` named `User`, table `users`, and columns `id`, `email`, `password`, then `orm.schema.createSchema()`.

```ts
it('em.find → one span "MikroORM find User" with table and system', ...);    // attributes db.collection.name 'users', db.system.name 'sqlite'
it('nested ORM calls produce one span', ...);                                 // em.find runs a QueryBuilder internally → 1 mikro-orm span
it('flush traced with driver work inside', ...);                              // em.create + persist + flush → 'MikroORM flush' span exists
it('transaction callback calls are traced as children', ...);                 // em.transactional(async em2 => { em2.create(...); await em2.flush(); })
it('repository calls traced once via em', ...);                               // em.getRepository('User').findAll() → 'MikroORM findAll User'
it('failure attaches redacted params', ...);                                  // em.insert('User', { id: 1, email: 'dup', password: 'hunter2' }) twice → params [{…password:'[REDACTED]'}]
it('stream is untouched', ...);                                               // if EntityManager.prototype.stream exists: not patched
it('skips absent methods', ...);
it('patch is idempotent', ...);
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm install && pnpm vitest run test/integration/mikro-orm.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `mikro-orm.ts`**

- [ ] **Step 4: Run them and confirm they pass**

Run: `pnpm vitest run test/integration/mikro-orm.test.ts`, then the full suite.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add MikroORM instrumentation"
```

---

### Task 5: Register the driver and ORM instrumentations in bootstrap

**Files:**
- Modify: `src/bootstrap/config.ts` (union), `src/bootstrap/detect.ts` (adapters), `src/bootstrap/instrumentations.ts` (entries), `package.json` (deps `@opentelemetry/instrumentation-pg`, `-mysql2`, `-mongodb`)
- Test: `test/unit/instrumentations.test.ts` (modify), `test/unit/detect.test.ts` (create if absent; otherwise modify the existing detect tests)

**Interfaces:**
- Produces:
  - `InstrumentationName` gains `'pg' | 'mysql2' | 'mongodb' | 'typeorm' | 'mikro-orm'`.
  - `ADAPTER_PACKAGES: Readonly<Record<string, readonly string[]>>`. Existing entries become one-element arrays. Added:
    - `pg: ['@mikro-orm/postgresql']`
    - `mysql2: ['@mikro-orm/mysql', '@mikro-orm/mariadb']`
    - `mongodb: ['@mikro-orm/mongodb']`

    `isInstalled` tries each adapter in order.
- **New `INSTRUMENTATIONS` entries:**
  - `pg`: `new PgInstrumentation({ enhancedDatabaseReporting: false, requestHook: (span, info) => safely(…, () => mask) })`. The hook re-sets `db.query.text`, and `db.statement` when present, to `maskSqlLiterals(info.query.text, { doubleQuotedStrings: false })`. Check the installed version's `requestHook` signature and which attribute names it sets.
  - `mysql2`: `new MySQL2Instrumentation({ maskStatement: true })`, keeping its default mask hook.
  - `mongodb`: `new MongoDBInstrumentation({ enhancedDatabaseReporting: false })`.
  - `typeorm` (pkg `typeorm`): `new TypeormInstrumentation()`.
  - `mikro-orm` (pkg `@mikro-orm/core`): `new MikroOrmInstrumentation()`.

- [ ] **Step 1: Write the failing tests**

```ts
it('db entries included only when installed', () => {
  const names = (inst: string[]) => buildInstrumentations(readBootstrapConfig({}), p => inst.includes(p)).map(i => i.instrumentationName);
  expect(names(['pg', 'typeorm'])).toEqual(expect.arrayContaining(['@opentelemetry/instrumentation-pg', '@oxth/nestjs-otel/instrumentation-typeorm']));
  expect(names([])).not.toContain('@opentelemetry/instrumentation-mysql2');
});
it('db entries can be disabled by name', ...);   // OTEL_NODE_DISABLED_INSTRUMENTATIONS=pg,mikro-orm
it('mysql2 masks statements by default', ...);   // created instrumentation getConfig().maskStatement === true
it('pg requestHook masks literals', ...);        // call the configured requestHook with a fake span + { query: { text: "… = 'hunter2'" } } → span.setAttribute called with masked text
it('isInstalled resolves pg via @mikro-orm/postgresql', ...);   // temp dir layout: node_modules/@mikro-orm/postgresql/{package.json,node_modules/pg/package.json} → true, while pg absent at root
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run test/unit/instrumentations.test.ts test/unit/detect.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the changes above**

- [ ] **Step 4: Run them and confirm they pass**

Run: `pnpm vitest run`, then `pnpm test:e2e` (Plan 1's e2e must still pass).
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: register pg, mysql2, mongodb, TypeORM and MikroORM instrumentations"
```

---

### Task 6: Docker DB tests against real Postgres, MySQL, and Mongo

**Files:**
- Create: `vitest.db.config.ts`, `test/db/global-setup.ts`, `test/db/helpers/containers.ts`, `test/db/orm.db.test.ts`, and fixture DB modules under `test/e2e/fixture/src/db/` (`typeorm.module.ts`, `mikro-orm.module.ts`, `entities.ts` (EntitySchemas `User` → table `users`: `id`, `email`, `password`), `users-db.service.ts`, `users-db.controller.ts`)
- Modify:
  - `test/e2e/fixture/src/app.module.ts`: imports the DB module only when `process.env.DB` is set.
  - `test/e2e/fixture/package.json`: adds `typeorm`, `@nestjs/typeorm`, `pg`, `mysql2`, `mongodb`, `@mikro-orm/core`, `@mikro-orm/nestjs`, `@mikro-orm/postgresql`, `@mikro-orm/mysql`, `@mikro-orm/mongodb`.
  - `test/e2e/global-setup.ts`: version substitution.
  - `package.json`: script `test:db`, dev dependency `testcontainers`.

**Interfaces:**
- Consumes: `spawnApp` / `startOtlpReceiver` (e2e helpers), the e2e global setup.
- Produces:
```ts
// containers.ts
export interface DbUrls { postgres: string; mysql: string; mongo: string }
export function startDatabases(): Promise<{ urls: DbUrls; stop(): Promise<void> }>;  // testcontainers GenericContainer: postgres:17, mysql:8.4, mongo:8 (single-node replica set not required)
```
- **`test/db/global-setup.ts`:** runs the e2e fixture setup, then `startDatabases()`. It exposes the URLs to tests through vitest `provide('dbUrls', urls)`, and stops the containers in teardown. If Docker is unavailable: throw when `REQUIRE_DOCKER=1`; otherwise `provide('dbUrls', null)` so the DB suite is skipped with a printed reason.
- **Version substitution in `test/e2e/global-setup.ts`:**
  - Only `@nestjs/common`, `core`, `platform-express`, `platform-fastify`, `microservices`, and `testing` get `NEST_VERSION`.
  - `@nestjs/typeorm` gets `^12` for Nest 12 and `^11` for Nest 11.
  - `typeorm` gets `TYPEORM_VERSION` (default `^1`).
  - `@mikro-orm/*` get `MIKRO_VERSION` (default `^7`), and `@mikro-orm/nestjs` gets `^7` for v7 and `^6` for v6.
- **Fixture DB mode:**
  - `DB` = `typeorm-pg` | `typeorm-mysql` | `mikro-pg` | `mikro-mysql` | `mikro-mongo`, with `DATABASE_URL`.
  - Uses `synchronize`/`schema.create` at startup.
  - `UsersDbController`:
    - `POST /db/users` `{ email, password }` → `UsersDbService.create` (repository `save` / em `insert`)
    - `GET /db/users/:id` → `UsersDbService.findOne`
    - `POST /db/users/dup` → inserts the same id twice, so the second fails with a unique violation → 500

**Scenarios** (each a `describe` in `orm.db.test.ts`): `typeorm-pg`, `typeorm-mysql`, `mikro-pg`, `mikro-mysql`, `mikro-mongo`. `mikro-pg` runs with both the `esm` and the `cjs` entry; the others use `esm`.

- [ ] **Step 1: Write the failing tests**

```ts
const scenarios = [['typeorm-pg', 'postgres', 'esm'], ['typeorm-mysql', 'mysql', 'esm'], ['mikro-pg', 'postgres', 'esm'],
                   ['mikro-pg', 'postgres', 'cjs'], ['mikro-mysql', 'mysql', 'esm'], ['mikro-mongo', 'mongo', 'esm']] as const;
describe.skipIf(!inject('dbUrls'))('databases', () => {
  describe.each(scenarios)('%s via %s (%s)', (db, store, entry) => {
    it('trace chain: server → controller → service → ORM → driver', async () => {
      const app = await spawnApp({ entry, preload: entry === 'esm', receiver, env: { DB: db, DATABASE_URL: urls[store] } });
      await app.get('/db/users/1');
      const orm = await receiver.waitFor(() => receiver.spans().find(s => s.attributes['db.orm.name'] && s.name.includes('find')));
      const svc = receiver.spans().find(s => s.name === 'UsersDbService.findOne')!;
      expect(orm.parentSpanId).toBe(svc.spanId);
      const driver = receiver.spans().find(s => s.parentSpanId === orm.spanId && (s.attributes['db.system.name'] ?? s.attributes['db.system']));
      expect(driver).toBeDefined();
    });
    it('secret never leaks on success', async () => {
      const app = await spawnApp({ entry, preload: entry === 'esm', receiver, env: { DB: db, DATABASE_URL: urls[store] } });
      await app.post('/db/users', { email: 'a@b.c', password: 'hunter2-SECRET' });
      await receiver.waitFor(() => receiver.spans().find(s => s.attributes['db.orm.name']));
      await app.stop();
      expect(JSON.stringify(receiver.spans())).not.toContain('hunter2-SECRET');
    });
    it('failure: ORM span has error and redacted params; secret absent', async () => {
      // POST /db/users/dup with { id: 1, email: 'd', password: 'hunter2-SECRET' } → 500
      const orm = await receiver.waitFor(() => receiver.spans().find(s => s.attributes['db.orm.name'] && s.status.code === 2));
      expect(orm.attributes['db.orm.params']).toContain('[REDACTED]');
      expect(JSON.stringify(receiver.spans())).not.toContain('hunter2-SECRET');
    });
  });
  it('pg driver metrics exported', async () => {   // typeorm-pg: db.client.operation.duration and db.client.connection.count present
    ...
  });
});
```

`spawnApp` needs a `post(path, body)` helper. Add it to `RunningApp` (JSON body).

- [ ] **Step 2: Run them and confirm they fail**

Run: `REQUIRE_DOCKER=1 pnpm test:db`
Expected: FAIL (the fixture has no DB modules yet, or no ORM spans are exported).

- [ ] **Step 3: Implement containers, global setup, fixture DB modules, version substitution, `post` helper, and the `test:db` script**

`vitest.db.config.ts`: include `test/db/**/*.db.test.ts`, globalSetup `test/db/global-setup.ts`, setupFiles `test/e2e/setup.ts`, `fileParallelism: false`, `hookTimeout: 600_000`.

- [ ] **Step 4: Run them and confirm they pass**

- `REQUIRE_DOCKER=1 pnpm test:db`: PASS.
- `NEST_VERSION=11 TYPEORM_VERSION=^0.3 MIKRO_VERSION=^6 REQUIRE_DOCKER=1 pnpm test:db`: PASS.
- `pnpm test:e2e`: still PASS, because the fixture without `DB` is unchanged.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test: add docker database tests for TypeORM and MikroORM"
```

---

### Task 7: README and CI

**Files:**
- Modify: `README.md`, `.github/workflows/ci.yml`, `test/unit/readme.test.ts`

**README additions:**
- **"Databases" section:**
  - Supported versions (TypeORM `>=0.3 <2`, MikroORM `>=6 <8`) and drivers (pg, mysql2, mongodb).
  - What a trace looks like.
  - Span names and attributes.
  - `db.captureParams` modes and `db.maxParamsBytes`, with defaults.
  - What's masked at the driver level: pg and mysql2 literals become `?`, Mongo values are masked.
  - Positional raw-query parameters keep their values when captured on failure.
  - Nested calls collapse into one span, and transactions show their inner calls.
  - Streams aren't traced.
  - How to disable each instrumentation by name.
- **Config reference table:** add `db.captureParams` and `db.maxParamsBytes`.
- **Roadmap:** mark Plan 2 done.

**CI:** add job `db` (ubuntu-latest, Docker available), matrix `{ nest: 12, typeorm: '^1', mikro: '^7' }` and `{ nest: 11, typeorm: '^0.3', mikro: '^6' }`, Node 24. Steps: install, build, then `REQUIRE_DOCKER=1 NEST_VERSION=… TYPEORM_VERSION=… MIKRO_VERSION=… pnpm test:db`.

- [ ] **Step 1: Write the failing test**

```ts
it('README documents db options', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const key of ['db.captureParams', 'db.maxParamsBytes']) expect(readme).toContain(`\`${key}\``);
  expect(readme).toMatch(/## Databases/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/unit/readme.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the README section and the CI job**

- [ ] **Step 4: Verify**

- `pnpm vitest run test/unit/readme.test.ts`: PASS.
- Parse `.github/workflows/ci.yml` with the repo's `yaml` package: no error.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: document database instrumentation and add db CI job"
```

---

## Spec coverage notes (Plan 2)

- **§6 TypeORM row:** covered by the driver instrumentations plus ORM-level spans with redacted parameters. **QueryRunner is not wrapped:** raw `queryRunner.query` calls already get driver spans, and wrapping it too would duplicate spans for every ORM call. **The plan's call.**
- **§6 MikroORM row:** covered.
- **§5.4 DB parameters:** redacted with the shared redactor and captured on failure by default. Driver-level values are masked.
- **§5.5 DB metrics:** whatever the driver instrumentations emit. `pg` emits `db.client.operation.duration` and connection metrics (asserted). `mongodb` emits connection count. `mysql2` emits none, and Plan 2 doesn't add any (spec: "where the driver exposes them").
- **Two exception events per DB failure:** the upstream driver instrumentation records the raw driver error on its own span, and the library records the ORM-level error once on the ORM span. Parent spans get status only. The spec's "exception event once" applies to events the library records; the driver's own event comes from an instrumentation the library doesn't control. **The plan's call;** documented in the README.
