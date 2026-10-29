# @oxth/nestjs-otel

OpenTelemetry for NestJS, with almost no setup: HTTP spans, a span per controller and provider method, errors with
the request body attached, logs and metrics correlated with traces, and redaction of secrets by default.

Requires Node >= 22.15 (an OpenTelemetry SDK requirement) and NestJS 11 or 12 (Express or Fastify).

## 60-second setup

```bash
pnpm add @oxth/nestjs-otel @opentelemetry/api
```

Start your app with the register hook preloaded:

```bash
node --import @oxth/nestjs-otel/register dist/main.js
```

Add the module:

```ts
import { Module } from '@nestjs/common';
import { OtelModule } from '@oxth/nestjs-otel';

@Module({ imports: [OtelModule.forRoot()] })
export class AppModule {}
```

Point it at a collector with two env vars:

```bash
export OTEL_SERVICE_NAME=my-api
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

That is it. See [examples/](examples/README.md) for a Collector + Tempo + Jaeger + Loki + Prometheus + Grafana stack.

## Bootstrap options

The SDK has to start before `@nestjs/core` (and `express`/`fastify`/`pino`) is loaded, so it can patch them.
`register` does that; there are three ways to load it.

### `--import` (recommended)

```bash
node --import @oxth/nestjs-otel/register dist/main.js
# or: NODE_OPTIONS="--import @oxth/nestjs-otel/register"
```

Works for both ESM and CommonJS apps.

### CommonJS: first-line import

```ts
// main.ts, first line, before anything else
import '@oxth/nestjs-otel/register';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3001);
}
void bootstrap();
```

### ESM: two-file pattern

In ESM, static imports are hoisted and evaluated before your code, so an in-code import only works if the app is
loaded afterwards with a dynamic import:

```ts
// main.ts
import '@oxth/nestjs-otel/register';
await import('./bootstrap.js');
```

```ts
// bootstrap.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

export const app = await NestFactory.create(AppModule);
await app.listen(3001);
```

Prefer `--import` where you can.

## What you get

- **HTTP**: a server span per request (`GET /users/:id`) with the Nest route, status code and, on failure, request
  data. Express and Fastify are detected and instrumented automatically.
- **`Class.method` spans**: controllers and providers are wrapped automatically (guards, interceptors, pipes and
  filters are opt-in, see [config](#config-reference)). Parent/child structure follows the call stack.
- **Errors**: exceptions are recorded on the span (type, message, stack) and the span is marked as an error.
  4xx `HttpException`s are not errors unless `errors.treat4xxAsError` is set.
- **Bodies on failure**: when a request fails, the (redacted, truncated) request body and the user id are attached to
  the server span. `capture.responseBody` additionally records `http.response.body`.
- **Logs**: `OtelLogger` prints like Nest's logger with `trace_id`/`span_id` appended, and exports every log as an
  OpenTelemetry log record. With pino, trace ids are injected into every line.
- **Metrics**: Node runtime metrics, HTTP server metrics, plus your own via `MetricService`, `@Counter` and
  `@Histogram`.

## Errors and redaction

What is redacted:

- **Request and response bodies** (`http.request.body`, `http.response.body`): sensitive keys and value patterns,
  using your `redact` options.
- **Exception messages and stacks** (`exception.message`, `exception.stacktrace`, the span status message) and
  **`OtelLogger` OTLP log bodies**: value patterns only (Bearer tokens, JWTs, plus your `redact.patterns`); there
  are no keys to match in free text.
- **Query strings** (`url.query` on server spans, `url.full` on client spans): parameters with a known credential
  name (`token`, `access_token`, `refresh_token`, `id_token`, `api_key`, `apikey`, `password`, `secret`, `code`,
  the default keys below, and instrumentation-http's own list such as `sig`, `X-Amz-Signature`) get the value
  `REDACTED`. Names match exactly and case-sensitively, and `redact` options don't apply here.

What is **not** redacted: `user.id` (from `capture.getUserId`), the URL path, other span attributes you or other
instrumentations set, `OtelLogger` console output, and pino records (use pino's own `redact` option).

Key matching is case-insensitive and ignores `-` and `_`, so `API_KEY`, `api-key` and `apiKey` are the same key.
Matching values are replaced by `[REDACTED]`.

Default sensitive keys (a key is redacted if it **contains** one of these):
`password`, `passwd`, `secret`, `token`, `authorization`, `apikey`, `cookie`, `session`, `creditcard`,
`cardnumber`, `cvv`, `ssn`, `privatekey`.
`auth` is **exact-match only** (a substring match would hit `author`).

Default sensitive headers: `authorization`, `cookie`, `set-cookie`, `x-api-key`.

Default value patterns (applied to string values anywhere): `Bearer <token>` and JWTs (`eyJ….….…`).

Extend or replace the defaults:

```ts
OtelModule.forRoot({
  redact: {
    keys: ['iban', 'dateOfBirth'], // added to the defaults
    patterns: [/\b\d{3}-\d{2}-\d{4}\b/g], // added to the defaults
    censor: '***', // replaces "[REDACTED]"
    custom: (value, path) => (path.at(-1) === 'email' ? '[email]' : value), // runs on every value
    // replaceDefaultKeys: true,      // drop the default keys instead of extending
    // replaceDefaultPatterns: true,  // same for patterns
  },
});
```

Opt a handler or controller out of body capture entirely with `@NoCaptureBody()`.

## Logger setup

### Nest logger

```ts
import { NestFactory } from '@nestjs/core';
import { OtelLogger } from '@oxth/nestjs-otel';

const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(OtelLogger));
```

`bufferLogs: true` holds bootstrap logs until the logger is set so they are not lost. `OtelLogger` accepts Nest's
`ConsoleLogger` options plus `console` (print to stdout/stderr, default `true`) and `otlp` (export as OTel logs,
default `true`). The one provided by `OtelModule` is a shared instance; you can also `new OtelLogger('Context', opts)`.

### pino (nestjs-pino)

Nothing special is needed: with `pino` installed, `register` enables the pino instrumentation, which adds
`trace_id`, `span_id` and `trace_flags` to every line.

```ts
app.useLogger(app.get(Logger)); // from nestjs-pino
```

If the instrumentation can't patch pino in your setup (a bundled or vendored pino, for example), use the fallback
mixin from `@oxth/nestjs-otel/pino`. Normally you do not need it:

```ts
import pino from 'pino';
import { otelPinoMixin } from '@oxth/nestjs-otel/pino';

const logger = pino({ mixin: otelPinoMixin() });
```

## Databases

With the driver packages installed, `register` instruments them automatically, and TypeORM and MikroORM calls get an
ORM-level span on top.

Supported: TypeORM `>=0.3 <2`, MikroORM `>=6 <8`; drivers `pg`, `mysql2` and `mongodb`. Each instrumentation is only
enabled when its package (`pg`, `mysql2`, `mongodb`, `typeorm`, `@mikro-orm/core`) is installed.

### What a trace looks like

```
GET /users/1
└─ UsersService.findOne
   └─ TypeORM find User            (ORM span)
      └─ pg.query:SELECT           (driver span)
```

The driver span sits beneath the ORM span. Other examples: `TypeORM save User`, `MikroORM flush`.

ORM span names are `<TypeORM|MikroORM> <operation>[ <Entity>]`. Attributes:

| Attribute | Value |
| --- | --- |
| `db.orm.name` | `typeorm` or `mikro-orm` |
| `db.operation.name` | The ORM method, e.g. `find`, `save`, `flush`, `getMany`. |
| `db.orm.entity` | Entity class name, when known. |
| `db.collection.name` | Table or collection name, when known. |
| `db.system.name` | `postgresql`, `mysql`, `mariadb`, `mongodb`, `sqlite`, ... when the driver type is known. |
| `db.orm.params` | Captured parameters (redacted JSON), see below. |
| `db.orm.params.truncated` | `true` when `db.orm.params` was cut at `db.maxParamsBytes`. |

Driver spans carry the upstream instrumentations' own attributes.

TypeORM: entity manager and repository methods, the select query builder (`getMany`, `getOne`, `getRawMany`,
`getCount`, ...) and `execute` of insert/update/delete query builders; `QueryRunner` is not wrapped (raw
`queryRunner.query` calls still get driver spans). MikroORM: entity manager methods, `flush`, and query builders.

Nested calls collapse into one span: a `find` that internally calls other ORM methods produces a single ORM span,
with the driver span(s) under it. Containers are the exception, so a transaction shows its inner calls:
TypeORM `manager.transaction(cb)` and MikroORM `em.transactional(cb)`. After an `em.transactional(cb)` callback you
will see a final `MikroORM flush` child: that is MikroORM committing the work done in the callback.

### Parameters and masking

`db.captureParams` decides when `db.orm.params` is recorded: `'error'` (default, only when the call fails),
`'always'` or `'never'`. `db.maxParamsBytes` (default `2048`) caps the serialized size; longer values are truncated
and `db.orm.params.truncated` is set. Parameters go through the same redactor as bodies (see
[Errors and redaction](#errors-and-redaction)).

```ts
OtelModule.forRoot({ db: { captureParams: 'error', maxParamsBytes: 2048 } });
```

- **Query builder failures** capture `{ values, parameters }`. TypeORM's generated `orm_param_N` and MikroORM's
  positional values are always `[REDACTED]`; keyed fields (e.g. `password`) go through the redactor.
- **Raw positional parameters** (`manager.query(sql, [..])`, `em.execute(sql, [..])`) are always censored: every
  value is `[REDACTED]` (the array length is kept). Keyed parameter objects go through the redactor.
- **Driver spans**: `pg` and `mysql2` query text has literals replaced with `?` (so `LIMIT 10` shows `LIMIT ?`).
  MongoDB values are masked by the instrumentation.
- **MikroORM 6** puts the interpolated SQL into its error messages. For errors from traced ORM calls, the library
  masks that statement in the span status, exception events and `OtelLogger` records (raw knex usage is not
  covered). This is best effort: the last 64 failing statements are tracked, within a 2 MB budget (oldest first
  out). Pino log lines are not masked, and database-native error details (e.g. MySQL
  `Duplicate entry 'x' for key ...`, a pg error detail) may contain values.

### Errors

A failed DB call shows two exception events: one on the driver span (recorded by the upstream instrumentation) and
one on the ORM span. Parent spans only get the error status.

### Metrics

Whatever the driver instrumentations emit: `pg` exports `db.client.operation.duration` and connection metrics,
`mongodb` the connection count, `mysql2` none.

### Not traced

Streaming APIs (TypeORM `stream()`, MikroORM `stream` and cursors) are not traced.

### Disabling

Turn off by name with `OTEL_NODE_DISABLED_INSTRUMENTATIONS` (e.g. `pg,mysql2,mongodb,typeorm,mikro-orm`), or
allow-list with `OTEL_NODE_ENABLED_INSTRUMENTATIONS`.

### Testing (contributors)

`pnpm test:db` runs the Docker suite (databases and BullMQ) against real containers (testcontainers: Postgres, MySQL,
MongoDB, Redis), so it needs Docker. Without Docker the suite is skipped; `REQUIRE_DOCKER=1` makes that a failure
(CI sets it). Select versions with `NEST_VERSION` (default `12`), `TYPEORM_VERSION` (default `^1`), `MIKRO_VERSION`
(default `^7`) and `BULLMQ_VERSION` (default `^6.5.1`; `@nestjs/bullmq` follows the Nest major), e.g.
`NEST_VERSION=11 TYPEORM_VERSION=^0.3 MIKRO_VERSION=^6 BULLMQ_VERSION=5.24.0 pnpm test:db`. `BULLMQ_VERSION`
also selects the BullMQ that the in-process suite (`test/db/bullmq.db.test.ts`) loads: major 5 uses the `bullmq-5`
dev dependency alias (pinned to `5.24.0`, the supported floor), anything else uses `bullmq`.

## Queues (BullMQ)

With `bullmq` installed, `register` instruments it automatically: producers and workers get spans, and the trace
continues from the HTTP request that enqueued a job into the worker that processes it.

Supported: BullMQ `>=5.24.0 <7` (optional peer dependency), including `@nestjs/bullmq`. The instrumentation is only
enabled when `bullmq` is installed and in range.

### What a trace looks like

```
POST /jobs
└─ JobsController.enqueue
   └─ JobsService.enqueue
      └─ add emails                    (producer span)
         └─ process emails             (consumer span)
            └─ EmailsProcessor.process
```

The `process` span is a child of the `add` span, and retried attempts stay in the same trace, each with its own
`process` span.

### Recorded operations

- Producers: `add`, `addBulk`, `addFlow`, `addBulkFlows` and flow `addNode`, as `add emails`, `addFlow parents`, ...
  (`messaging.operation.type = send`).
- Workers: `process` (`process emails`, `messaging.operation.type = process`), one per job attempt.

Other operations BullMQ traces internally (polling for jobs, lock renewal, stalled-job checks, `pause`, `resume`,
`close`, `clean`, ...) get no span and run with tracing suppressed. Read-only calls such as `getJob` and `getJobs`
are not traced by BullMQ at all, so they get no span either. An idle worker records no spans.

Span attributes: `messaging.system = bullmq`, `messaging.operation.name`, `messaging.operation.type`,
`messaging.destination.name` (the queue), `messaging.message.id` (the job id), `messaging.batch.message_count`, and
a fixed allowlist of `bullmq.*` attributes (`bullmq.job.name`, `bullmq.job.id`, `bullmq.job.attempts.made`, ...).
The `process` span adds `bullmq.job.attempt`, `bullmq.job.attempts.max`, `bullmq.job.outcome` and, on failure,
`bullmq.job.will_retry`.

### Context propagation

BullMQ propagates the trace context itself, in its own format: a JSON W3C carrier stored in the job options. It is
the same format as [`bullmq-otel`](https://github.com/appsignal/bullmq-otel), so services using `bullmq-otel` and
services using this library join the same traces.

If your app passes its own `telemetry` (for example `BullModule.forRoot({ telemetry: new BullMQOtel('app') })`),
it wins: the library never replaces it, and BullMQ's spans appear once. When that telemetry has a `meter`, BullMQ
emits its own `bullmq.jobs.*` metrics and the library's job metrics are skipped. Errors, attempts and job data
are still recorded on the `process` span.

Caveats:

- **`FlowProducer`**: BullMQ only propagates trace context to flow nodes that have an `opts` object. Pass
  `opts: {}` (or any options) on each node to keep children in the flow's trace. The same applies to `bullmq-otel`.
- A job added without propagated context (by a producer without telemetry, or, on BullMQ 6 only, with
  `telemetry: { omitContext: true }`; BullMQ 5.24 ignores that option) starts its own trace on both majors: its
  `process` span is a root and is not attached to whatever span the worker was created in. The processor still
  runs under that `process` span, so its spans, attempts, outcome and errors are recorded as usual.

### Job data and masking

`bullmq.captureData` decides when `bullmq.job.data` is recorded on the `process` span: `'error'` (default, only
when the job fails), `'always'` or `'never'`. `bullmq.maxDataBytes` (default `8192`) caps the serialized size;
longer values are truncated and `bullmq.job.data.truncated` is set. Data goes through the same redactor as bodies
(see [Errors and redaction](#errors-and-redaction)).

```ts
OtelModule.forRoot({ bullmq: { captureData: 'error', maxDataBytes: 8192 } });
```

Job return values are never recorded, and `bullmq.job.result`, job options and progress are dropped from spans,
so a secret in a result cannot reach a backend.

### Errors and attempts

A failed job shows the exception event (with the stack) on the innermost span, for example
`EmailsProcessor.process`; the `process` span gets the error status only. `bullmq.job.will_retry` is `true` when
another attempt is left (never for `UnrecoverableError`).

Control-flow outcomes are not errors: a job that moves itself to delayed, waiting, waiting-children, or is
rate-limited only sets `bullmq.job.outcome` (`delayed`, `waiting`, `waiting-children`, `rate-limited`). They record
no error status and no metrics.

### Metrics

Meter `@oxth/nestjs-otel`, attributes `messaging.system`, `messaging.destination.name`,
`messaging.operation.name` and `bullmq.job.name`:

| Metric | Type | Notes |
| --- | --- | --- |
| `bullmq.jobs.completed` | counter | Completed attempts. |
| `bullmq.jobs.failed` | counter | Failed attempts, with `bullmq.job.will_retry`. |
| `messaging.process.duration` | histogram, `s` | Processor time; `error.type` on failure. |
| `bullmq.job.wait_time` | histogram, `s` | Enqueue (plus delay) to start; first attempt only. |

Both histograms use second-based bucket boundaries (`messaging.process.duration` from 5 ms to 10 s,
`bullmq.job.wait_time` from 10 ms to 1 h) instead of the SDK's millisecond-oriented defaults.

### Not traced

Sandboxed processors (a processor file path, which BullMQ runs in a child process) are not instrumented inside the
child. Only the `process` span in the parent is recorded.

### Disabling

Turn off by name with `OTEL_NODE_DISABLED_INSTRUMENTATIONS=bullmq`.

Disabling the instrumentation at runtime (`instrumentation.disable()`) affects only new `Queue`, `Worker` and
`FlowProducer` instances. A `Queue` or `Worker` that has already run an operation keeps the telemetry stored in its
options and keeps recording (an existing `FlowProducer` without its own `telemetry` stops being traced).

## Decorators, `TraceService` and `MetricService`

```ts
import { Injectable } from '@nestjs/common';
import { Counter, Histogram, MetricService, NoTrace, Span, SpanAttribute, Trace, TraceService } from '@oxth/nestjs-otel';

@Trace() // force tracing of this class even in a dynamic module (see Notes)
@Injectable()
export class OrdersService {
  constructor(
    private readonly trace: TraceService,
    private readonly metrics: MetricService,
  ) {}

  @Span('orders.place') // custom span name; default is "OrdersService.place"
  @Counter('orders_placed_total') // +1 per call
  @Histogram('orders_place_duration') // duration in seconds, failures get error.type
  place(@SpanAttribute('order.customer') customer: string, total: number) {
    this.trace.setAttributes({ 'order.total': total });
    this.metrics.counter('orders_value_total').add(total);
  }

  async refund(id: string) {
    return this.trace.startActiveSpan('orders.refund', async (span) => {
      span.setAttribute('order.id', id);
      // ... span ends when the promise settles; failures are recorded on it
    });
  }

  @NoTrace() // never auto-traced
  health() {}
}
```

- `@Trace()` / `@NoTrace()` (class or method): force or skip automatic tracing. `exclude` wins over everything.
- `@Span(name?, { attributes })`: explicit span around a method (sync, Promise or Observable aware).
- `@SpanAttribute(name)`: records a primitive argument as a span attribute.
- `TraceService`: `getActiveSpan()`, `setAttributes()`, `recordException()`, `startActiveSpan(name, fn, opts?)`.
- `MetricService`: `counter()`, `histogram()`, `upDownCounter()`, `gauge()`; instruments are cached by name.
- `@Counter(name, opts?)` and `@Histogram(name, opts?)`: metric per method call; `opts` are OpenTelemetry
  `MetricOptions` plus fixed `attributes`.

## Config reference

`OtelModule.forRoot(options)` and `OtelModule.forRootAsync({ imports, inject, useFactory })` take
`OtelModuleOptions`:

| Option | Default | Description |
| --- | --- | --- |
| `autoInstrument.controllers` | `true` | Span per controller method. |
| `autoInstrument.providers` | `true` | Span per provider method. |
| `autoInstrument.guards` | `false` | Span per guard. |
| `autoInstrument.interceptors` | `false` | Span per interceptor. |
| `autoInstrument.pipes` | `false` | Span per pipe. |
| `autoInstrument.filters` | `false` | Span per exception filter (classes decorated with `@Catch()`). |
| `autoInstrument.include` | `[]` | Class names (string or RegExp) always wrapped, even in dynamic modules. |
| `autoInstrument.exclude` | `[]` | Class names (string or RegExp) never wrapped. Wins over `include` and `@Trace()`. |
| `errors.treat4xxAsError` | `false` | Mark spans of 4xx `HttpException`s as errors. |
| `capture.requestBody` | `true` | Attach the (redacted) request body to the server span on failure. |
| `capture.responseBody` | `false` | Record `http.response.body` (redacted). |
| `capture.maxBodyBytes` | `8192` | Bodies larger than this are truncated. |
| `capture.getUserId` | `req => req.user?.id` | Returns the user id recorded on failure. |
| `redact.keys` | `[]` | Extra sensitive key names, added to the defaults. |
| `redact.replaceDefaultKeys` | `false` | Drop the default keys and headers instead of extending them. |
| `redact.patterns` | `[]` | Extra value patterns, added to the defaults. |
| `redact.replaceDefaultPatterns` | `false` | Drop the default value patterns. |
| `redact.censor` | `'[REDACTED]'` | Replacement text. |
| `redact.custom` | none | `(value, path) => value`, runs on every value. |
| `db.captureParams` | `'error'` | When to record ORM query parameters: `'error'`, `'always'` or `'never'`. |
| `db.maxParamsBytes` | `2048` | Captured parameters larger than this are truncated. |
| `bullmq.captureData` | `'error'` | When to record job data on the `process` span: `'error'`, `'always'` or `'never'`. |
| `bullmq.maxDataBytes` | `8192` | Captured job data larger than this is truncated. |

## Environment variables

Standard OpenTelemetry variables are honored by the SDK, for example:

| Variable | Purpose |
| --- | --- |
| `OTEL_SERVICE_NAME` | Service name. Defaults to the `name` in the app's `package.json`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector URL (default `http://localhost:4318`). |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default), `http/json` or `grpc`. |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes, `k=v,k=v`. |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Sampling. |
| `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BLRP_SCHEDULE_DELAY`, `OTEL_METRIC_EXPORT_INTERVAL` | Export intervals. |

Handled by this library:

| Variable | Purpose |
| --- | --- |
| `OTEL_SDK_DISABLED=true` | Do not start the SDK. `OtelModule` stays harmless. |
| `OTEL_NODE_ENABLED_INSTRUMENTATIONS` | Comma list; only these of `http`, `express`, `fastify`, `pino`, `runtime-node`, `pg`, `mysql2`, `mongodb`, `typeorm`, `mikro-orm`, `bullmq`, `kafkajs`, `amqplib`, `ioredis`, `redis`, `aws-sdk`. |
| `OTEL_NODE_DISABLED_INSTRUMENTATIONS` | Comma list of the same names to turn off. |

`service.version` is read from `package.json` and `deployment.environment.name` from `NODE_ENV`, unless set in
`OTEL_RESOURCE_ATTRIBUTES`.

## Troubleshooting

**`register was loaded after @nestjs/core`** (CommonJS): `@nestjs/core` was `require`d before
`@oxth/nestjs-otel/register`, so HTTP and library patches may be missing. Use `--import`, or make the register
import the very first line of your entry file.

**`OtelModule loaded but register was not`**: the module is imported but the SDK never started, so only spans from
decorators are created. Add `--import @oxth/nestjs-otel/register` to the start command (and to your Dockerfile
`CMD`, or `NODE_OPTIONS`). Set `OTEL_SDK_DISABLED=true` to silence it on purpose.

**No data arrives**: check `OTEL_EXPORTER_OTLP_ENDPOINT` and protocol. Export errors are printed once per minute to
stderr as `@oxth/nestjs-otel: telemetry export error: ...`.

## Notes and limitations

- **Dynamic modules**: providers declared in dynamic modules (`forRoot()`/`register()`) are not auto-traced. Use
  `@Trace()` or `autoInstrument.include`. Providers of static library modules (e.g. `DiscoveryModule`,
  `TerminusModule`) **are** traced; use `autoInstrument.exclude` for those.
- **Exception filters**: classes decorated with `@Catch()` are treated as exception filters and are not auto-traced
  unless `autoInstrument.filters: true`. Other providers with a `catch()` method are traced like any provider.
- **Guards**: an error thrown in a guard is recorded on the server span (with the request body and user id), but
  there is no `http.response.body` for it.
- **Shutdown**: on SIGTERM/SIGINT, if nothing else listens for the signal, the SDK is flushed and shut down, then the
  signal is re-raised. With no reachable collector this waits up to 5 s for the export to time out. If something
  else listens (e.g. `app.enableShutdownHooks()`), the library leaves shutdown to it: `OtelModule` shuts the SDK
  down after Nest's shutdown hooks, so telemetry from in-flight requests and the hooks is still exported. If your
  own signal handler calls `process.exit()` without closing the Nest app, nothing is flushed.
- **Uncaught exceptions**: if no other `uncaughtException` listener exists, the library flushes telemetry for up to
  2 s, prints the error and exits with code 1, like Node's default but with the FATAL log delivered. Differences
  from Node's default crash: the exit is delayed by the flush (at most 2 s), `--abort-on-uncaught-exception` no
  longer produces a core dump, and the printed error lacks Node's source-line context (the `file:line` excerpt
  with a caret above the stack).
- **One Nest app per process** is the supported setup; options are process-global.
- **Overhead**: `pnpm bench` measures p99 latency of the e2e fixture with and without the library (a tracked goal,
  not a gate; CI posts the result to the job summary).

## Roadmap

Plan 1 (core) and Plan 2 (database tracing for TypeORM and MikroORM, with pg, mysql2 and mongodb) are done. Planned next:

- **Plan 3**: microservice handler spans, BullMQ, job data and message payloads, microservice metrics.
- **Plan 4**: integrations beyond HTTP and pino, and opt-in request header capture (using `redactHeaders`).

## License

MIT
