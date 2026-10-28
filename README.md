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

Everything captured from requests (bodies, user ids, error data) goes through the redactor first. Matching is
case-insensitive and ignores `-` and `_`, so `API_KEY`, `api-key` and `apiKey` are the same key. Matching values
are replaced by `[REDACTED]`.

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
| `autoInstrument.filters` | `false` | Span per exception filter (classes with a `catch()` method). |
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
| `OTEL_NODE_ENABLED_INSTRUMENTATIONS` | Comma list; only these of `http`, `express`, `fastify`, `pino`, `runtime-node`. |
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
- **Exception filters**: classes with a `catch()` method are treated as exception filters and are not auto-traced
  unless `autoInstrument.filters: true`.
- **Guards**: an error thrown in a guard is recorded on the server span (with the request body and user id), but
  there is no `http.response.body` for it.
- **Shutdown**: on SIGTERM/SIGINT the SDK is flushed and shut down. With no reachable collector this waits up to
  5 s for the export to time out.
- **Uncaught exceptions**: if no other `uncaughtException` listener exists, the library flushes telemetry for up to
  2 s, prints the error and exits with code 1, like Node's default but with the FATAL log delivered.
- **One Nest app per process** is the supported setup; options are process-global.
- **Overhead**: `pnpm bench` measures p99 latency of the e2e fixture with and without the library (a tracked goal,
  not a gate; CI posts the result to the job summary).

## Roadmap

This is Plan 1 (core). Planned next:

- **Plan 2**: microservice handler spans, redaction of DB parameters, job data and message payloads.
- **Plan 3**: BullMQ, database and microservice metrics.
- **Plan 4**: integrations beyond HTTP and pino, and opt-in request header capture (using `redactHeaders`).

## License

MIT
