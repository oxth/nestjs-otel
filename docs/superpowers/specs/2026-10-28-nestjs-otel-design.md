# @oxth/nestjs-otel — Design

Date: 2026-10-28
Status: Draft, awaiting approval

## 1. Intent

A near-zero-config observability library for NestJS that does what `@nestjs/observe` does (install it, get useful telemetry), but is open and vendor-neutral: it sends everything over **OTLP** to any OpenTelemetry-compatible backend (Jaeger, Grafana Tempo/Loki/Mimir, Honeycomb, Datadog, an OTel Collector, and so on).

**Why:** today every new NestJS app needs OpenTelemetry wired by hand: SDK bootstrap, instrumentation choices, custom spans, manual error recording. Errors in particular come through badly. Stack traces and the class or method that threw are often missing, because Nest's exception layer swallows errors before OTel sees them. The author wants Sentry-quality error context inside their OTLP traces, without writing that plumbing again for each app.

**Success:** in a fresh NestJS app, you add one bootstrap line (`--import` flag or import), add `OtelModule.forRoot()` to `AppModule`, set `OTEL_SERVICE_NAME` and `OTEL_EXPORTER_OTLP_ENDPOINT`, and run the app. Jaeger/Tempo then shows connected traces across HTTP → services → DB → BullMQ jobs → other microservices, failed spans carry the full stack trace and the `Class.method` that threw, logs carry `trace_id`/`span_id`, and RED metrics arrive, all without writing instrumentation code.

## 2. Goals

1. **One-line bootstrap.** Two supported ways (author's decision: support both):
   - `node --import @oxth/nestjs-otel/register dist/main.js` (no code change). This is the main, recommended way and works for both CJS and ESM apps.
   - In-code import:
     - **CJS-compiled apps:** `import '@oxth/nestjs-otel/register';` as the first line of `main.ts`.
     - **ESM apps:** in ESM, all static imports load before any of them runs, so a first-line import is too late to instrument libraries. The documented pattern is a small `main.ts` that does `import '@oxth/nestjs-otel/register'` and then `await import('./bootstrap.js')`, with the real bootstrap moved into that second file. The README shows both pieces. Optionally, the library warns at startup if it detects that instrumented modules were already loaded before `register` ran.
   - Bootstrap alone gives HTTP, DB, queue, and transport instrumentation. **The NestJS-aware layer (5.2, 5.3, 5.6) also requires `OtelModule.forRoot()` in `AppModule`** (author's decision). The library does not patch NestJS from outside its DI system.
2. **Config from standard OTel env vars** (`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER`, `OTEL_SDK_DISABLED`, …). The library adds nothing that duplicates an existing standard variable.
3. **`OtelModule.forRoot()` / `forRootAsync()`** turns on the NestJS-aware layer: controller, provider, and handler spans; error capture through filters; logger integration; redaction rules; body capture; and custom metrics. Every option has a sensible default, so `OtelModule.forRoot()` with no arguments works. `forRoot()` can turn off only the parts the module itself owns: the Nest-layer wrappers, including the ORM-level and BullMQ wrappers if those are applied from the module. Driver and library instrumentations are installed at bootstrap, before `forRoot()` runs, so they are switched on and off through the bootstrap config (env vars or config file, 5.1).
4. **Traces, metrics, and logs**, all exported over OTLP, with logs correlated to traces.
5. **Sentry-style error capture** (section 5.3).
6. **Request body capture with redaction** (section 5.4).
7. **Auto-detected integrations:** each one turns on only if its target package is installed, and each can be switched off.
8. **Supported versions:** NestJS 12 (primary target, ESM) and NestJS 11. NestJS 10 is out of scope. Node.js ≥ 22. Ships as both CJS and ESM.

## 3. Non-goals (v1)

- Hosting a backend, UI, or dashboards. (Optional example Grafana dashboards in `examples/` are allowed but not part of the package.)
- Non-NestJS frameworks.
- Browser or frontend telemetry.
- Replacing the OTel SDK. The library builds on `@opentelemetry/sdk-node` and the official contrib instrumentations; it does not re-implement them.
- GraphQL and WebSocket gateways. They're not in the author's stack; they're a candidate for v2.
- Profiling and session replay.

## 4. Anti-goals

*Proposed by the designer; the author did not specify these.* The library has failed, even if every feature works, if:

- **It noticeably slows the app.** Target: < 5% p99 latency overhead on a simple HTTP route with default settings, measured in a benchmark that ships with the repo. This is a tracked goal, not a hard CI gate. If the defaults miss it, per-provider-method spans are the first default to turn off (keeping controller and handler spans). Measure early, as soon as provider wrapping exists.
- **It leaks secrets.** Redaction must be on by default and must apply to everything the library itself records: bodies, headers, query params, DB parameters, job data.
- **It crashes or blocks the app** because a backend is down or misconfigured. Exporter failures are logged once (rate-limited) and never thrown into app code. Startup never blocks on the exporter.
- **Teams have to read the OTel docs to get basic value.** If the default path needs more than the bootstrap line, `OtelModule.forRoot()`, and two env vars, that's a bug.
- **It locks users in.** Everything emitted uses OTel semantic conventions, and users can still add their own instrumentations or SDK configuration.

## 5. Behavior

### 5.1 Bootstrap (`register`)

- Starts the OTel `NodeSDK` before Nest and any instrumented library are loaded. Reads config from env vars.
- Registers OTLP exporters for traces, metrics, and logs. Protocol comes from `OTEL_EXPORTER_OTLP_PROTOCOL`; the default is `http/protobuf`.
- Registers the instrumentations for every supported package that is installed (section 6).
- Sets resource attributes: `service.name`, `service.version` (from `package.json` if not set), `deployment.environment.name` (from `NODE_ENV` if not set), and host/process/container detectors.
- Flushes and shuts down gracefully on `SIGTERM`/`SIGINT`, and also through a Nest `onApplicationShutdown` hook when the module is loaded.
- `OTEL_SDK_DISABLED=true` turns everything into a no-op.
- **Settings that are known before modules load** (which instrumentations are on, sampling, exporter settings) must be configurable without code: env vars, plus an optional `OXTH_OTEL_*` variable or a config file *only* for settings with no standard OTel env var. The builder picks the exact mechanism and keeps it minimal.
- **Settings that are only needed at request time** (redaction rules, body capture, custom metrics) come from `OtelModule.forRoot()`.

### 5.2 NestJS-aware tracing

- **HTTP:** works with both the Express and Fastify adapters. The root span name uses the route template (`GET /users/:id`), not the raw URL.
- **Controllers and providers:** child spans for controller handlers and for provider (service) methods, named `ClassName.methodName`, with attributes `code.namespace` (class) and `code.function` (method).
  - Default: controllers and `@Injectable()` providers in the app's own modules are traced. Framework internals and providers from `node_modules` are not.
  - Users can opt out per class or method (`@NoTrace()`) and opt in explicitly (`@Trace()` / `@Span('name')`).
  - Guards, interceptors, and pipes: traced only if enabled in config (off by default, to avoid noise).
- **Microservice handlers** (`@MessagePattern`, `@EventPattern`): one span per handler, same naming, with messaging semantic-convention attributes (`messaging.system`, destination/pattern).
- **Manual API:** an injectable `TraceService` (current span, set attributes, record an exception, start a span) and decorators: `@Span()`, `@Trace()`, `@NoTrace()`, `@SpanAttribute()` (to mark a method parameter as an attribute).

### 5.3 Error capture (Sentry-style)

When an error goes through a traced span:

- `span.recordException(err)` records `exception.type`, `exception.message`, and `exception.stacktrace`, and the span status is set to `ERROR`.
- The span that threw is the **innermost** traced `Class.method`, so the trace shows exactly which service or method threw. Parent spans also record the error status, but the exception event is attached once (on the innermost span) to avoid duplicates.
- **Errors caught by Nest's exception filters are still recorded.** The library hooks in where it sees the exception before or alongside the filter (for example a global interceptor plus the base exception filter path), so it works with the user's own custom filters too.
- **Classification:** `HttpException` with a 4xx status is *not* an error by default. It's recorded as a span event and attribute, and the status stays unset. 5xx responses, non-HTTP exceptions, `RpcException`, and unhandled rejections are errors. This is configurable (for example, treating 4xx as errors).
- `error.cause` chains are included in the recorded stack trace.
- Context attached to the failing root span: route, HTTP method, status code, client IP (configurable), user id when available (resolved through a configurable `getUserId(request)` hook, which reads `req.user?.id` by default), and the redacted request body (section 5.4, failed requests only).
- `uncaughtException` / `unhandledRejection` at process level: recorded on the active span if one exists. Otherwise they're emitted as an error log record with the stack. The library never swallows them; Node's default behavior is kept.

### 5.4 Request body capture and redaction

- **The request body is attached only to failed requests** (author's decision): the 5xx and error cases defined in 5.3. It's stored on the root span as the attribute `http.request.body` (a JSON string). Successful requests never carry a body. Since the body has already been parsed by Nest, keeping a reference costs little; redaction and serialization run only when an error happens. Capturing on every request is not offered in v1. Response body capture is off by default, available as an option (also on errors only).
- **Size limit:** 8 KB by default (configurable). Larger bodies are cut off and marked with `http.request.body.truncated=true`.
- **Skipped:** multipart, binary, and streams. These record content type and size only.
- **Redaction** runs inside the app process before data reaches any exporter:
  - Default sensitive keys, matched case-insensitively at any depth, as a key substring: `password`, `passwd`, `secret`, `token`, `authorization`, `auth`, `apikey`/`api_key`, `cookie`, `session`, `creditcard`/`card_number`, `cvv`, `ssn`, `private_key`.
  - Values are replaced with `[REDACTED]`.
  - Users can extend or replace the key list, add regex value patterns (for example to catch JWTs or card numbers anywhere in a string), or provide a custom redact function.
  - The same redactor applies to headers (`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` redacted by default), query strings, DB query parameters, BullMQ job data (when captured), and microservice message payloads (when captured).
- Body capture can be turned off globally, or per route with `@NoCaptureBody()`.

### 5.5 Metrics

Exported through the OTLP metric exporter. Names follow OTel semantic conventions where one exists.

- **HTTP server:** `http.server.request.duration` histogram (attributes: route, method, status code).
- **Microservice handlers:** a duration histogram plus error count, by transport and pattern.
- **BullMQ:** jobs completed and failed (counters), processing duration (histogram), queue wait time (histogram), by queue and job name.
- **DB:** `db.client.operation.duration` from the driver instrumentations, plus connection-pool metrics where the driver exposes them.
- **Node runtime:** event-loop delay, heap/memory, GC, CPU (through `@opentelemetry/instrumentation-runtime-node` or the equivalent current package).
- **Custom metrics:** an injectable `MetricService` (counter, histogram, up-down counter, gauge) plus convenience decorators such as `@Counter('name')` and `@Histogram('name')` on methods.

### 5.6 Logs with trace correlation

- **nestjs-pino:** a mixin adds `trace_id`, `span_id`, and `trace_flags` to every log line. Logs are exported over OTLP through the pino instrumentation or a transport. Stdout output keeps working.
- **Built-in Nest `Logger`:** the library exports a drop-in `OtelLogger` (used with `app.useLogger(app.get(OtelLogger))`, or wired automatically by `OtelModule`) that keeps Nest's normal console format and adds trace IDs, then emits OTLP log records. Severity is mapped from the Nest log level.
- `logger.error(msg, stack)` while a span is active also attaches an exception event to that span (deduplicated against 5.3).
- The default mode exports to OTLP *and* keeps stdout. Either can be turned off.

## 6. Integrations

Each integration is enabled when its package is installed (detected with `require.resolve` at register time). Libraries are **optional peer dependencies** of `@oxth/nestjs-otel`. Each integration can be disabled by name.

| Target | Approach |
|---|---|
| HTTP (Express, Fastify) | Official `instrumentation-http`, `-express`, `-fastify` (or `@fastify/otel`), plus Nest route-template naming |
| NestJS core | The library's own controller/provider/handler spans (5.2), plus `instrumentation-nestjs-core` if it adds value without duplicate spans; the builder decides |
| TypeORM | Driver-level spans from official instrumentations (`pg`, `mysql2`, `mongodb`, …), plus the library's own ORM-level spans by wrapping Repository/EntityManager/QueryRunner: `db.operation`, entity name, and redacted parameters |
| MikroORM | Same pattern: driver instrumentations, plus ORM-level spans by wrapping `EntityManager` (find/flush/etc.) |
| BullMQ | The library's own instrumentation (an existing community package may be used if it is maintained and fits): inject trace context into job data/opts on `Queue.add`/`addBulk`/`FlowProducer`, extract it in `Worker` processing. The consumer span is a child of the producer span when that makes sense, or uses a span link (follow OTel messaging conventions). Records job attempts and failures with the stack trace |
| Kafka transport | Official `instrumentation-kafkajs`, plus context propagation in Nest's Kafka message headers |
| RabbitMQ transport | Official `instrumentation-amqplib`, plus propagation in message properties/headers |
| Redis transport | `ioredis`/`redis` instrumentation for commands, plus context propagation inside the Nest message envelope, since Redis pub/sub has no headers |
| TCP transport | Context propagation inside the Nest message envelope |
| SQS | `instrumentation-aws-sdk` (which propagates through SQS message attributes), plus consumer-side extraction for common NestJS SQS packages (`@ssut/nestjs-sqs` first). Custom transports use the manual helpers below |
| Manual propagation | Exported `injectContext(carrier)` / `extractContext(carrier)` / `withContext(ctx, fn)` helpers for any custom transport |

**Propagation:** W3C `traceparent` / `tracestate` plus `baggage` by default, overridable with `OTEL_PROPAGATORS`.

**Envelope transports (TCP, Redis):** the trace context is added in a way that does not break consumers that don't use the library. For example, an extra field that Nest's deserializer ignores. Wire compatibility with plain Nest services is a must.

## 7. Package shape

- A single package, `@oxth/nestjs-otel`.
- Entry points:
  - `@oxth/nestjs-otel`: `OtelModule`, decorators, `TraceService`, `MetricService`, `OtelLogger`, propagation helpers
  - `@oxth/nestjs-otel/register`: side-effect bootstrap
  - `@oxth/nestjs-otel/pino`: pino mixin/transport helpers
- Written in TypeScript, published as dual CJS/ESM with type declarations. `--import` support requires the ESM loader hooks (`import-in-the-middle`) to be registered correctly.
- Dependencies: `@opentelemetry/api` (peer), `@opentelemetry/sdk-node`, the OTLP exporters, and the official instrumentations used. NestJS packages and all ORM/queue/transport libraries are peer dependencies (optional where applicable).

## 8. Quality bar

- **Unit tests:** Vitest. The redactor, error classification, naming, and propagation helpers each need thorough coverage.
- **Integration tests:** real NestJS apps (Express and Fastify) against an in-memory span/metric/log exporter, plus Docker-based tests against a real OTel Collector, Postgres, MySQL, Redis, Kafka, RabbitMQ, and LocalStack (for SQS).
- **CI matrix:** NestJS 11 / 12 × Node 22 / 24, covering CJS and ESM apps, with both bootstrap forms (`--import` and the in-code import).
- **Overhead benchmark** (anti-goal 1) runs in CI and reports results.
- **Examples:** `examples/` with a docker-compose file (OTel Collector → Jaeger + Tempo + Loki + Prometheus/Mimir + Grafana), so the setup can be checked visually.
- **README:** the "60-second setup" comes first, followed by a config reference.

## 9. Left to the builder

- The exact internal hooking technique for Nest controllers/providers (DiscoveryService plus method wrapping, interceptors, or similar), as long as 5.2 and 5.3 hold.
- Whether to depend on `instrumentation-nestjs-core` or replace it.
- Whether to use an existing community BullMQ instrumentation or write one.
- The env-var/config-file mechanism for settings that are needed before modules load (keep it minimal).
- Repo tooling (pnpm/npm, tsup/tsdown/unbuild, lint, changesets/release-please).
- Release and versioning process.
- The order of integrations within v1 (suggestion: HTTP + errors + redaction + logs first, then DB, then BullMQ, then the transports).

## 10. Designer's calls (the author did not decide these)

- NestJS 11 is supported alongside 12; NestJS 10 is dropped (the author said older versions are "good if possible", and supporting 10 alongside ESM-only 12 costs too much).
- Anti-goals in section 4, including the < 5% p99 overhead target as a tracked goal, not a gate, with provider-method spans as the first default to turn off.
- 4xx responses are not errors by default.
- The default sensitive-key list, the 8 KB body limit, response bodies off by default, and multipart/binary skipped.

**The author decided:** `OtelModule.forRoot()` is required for the Nest-aware layer; both bootstrap forms are supported, including the ESM dynamic-import pattern; request bodies go on failed requests only.
- Default OTLP protocol `http/protobuf`.
- Guards, pipes, and interceptors are not traced by default.
- GraphQL and WebSockets are out of scope for v1.
- Single package with optional peer dependencies, and no plugin packages.
