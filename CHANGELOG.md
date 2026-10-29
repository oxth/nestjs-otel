# Changelog

## 0.1.0

First release. NestJS 11 and 12, Node.js 22.15 or later, CJS and ESM.

- **Bootstrap:** one line (`node --import @oxth/nestjs-otel/register`, or an in-code import). It starts the
  OpenTelemetry SDK, which exports traces, metrics and logs over OTLP and is configured with standard `OTEL_*` env vars.
- **`OtelModule.forRoot()`:**
  - Route-named HTTP spans (Express and Fastify) and `Class.method` spans for controllers and providers.
  - Decorators: `@Trace`, `@NoTrace`, `@Span`, `@SpanAttribute`, `@Counter`, `@Histogram`.
  - `TraceService` and `MetricService`.
- **Errors:**
  - Each error is recorded once, with its stack trace, on the innermost span, including errors that Nest's
    exception filters catch.
  - 4xx responses are not errors by default.
  - The redacted request body is attached on failure.
- **Logs:** `OtelLogger` (Nest logger) and pino correlation (`trace_id`, `span_id`), exported over OTLP.
- **Databases:**
  - TypeORM and MikroORM ORM-level spans, with parameters redacted on failure.
  - `pg`, `mysql2` and `mongodb` driver spans, with literals masked.
- **BullMQ (5.24 and later):** producer and `process` spans connected across the queue, attempts and retries, job data
  redacted on failure, and job metrics. Idle workers record nothing.
- **Microservices:**
  - Client and handler spans for TCP, Redis, Kafka, RabbitMQ and SQS (`@ssut/nestjs-sqs`). Context travels in the
    packet `metadata` on TCP and Redis, which stays wire-compatible with plain Nest, and through headers or message
    attributes on the others.
  - Payloads redacted on failure.
  - Handler metrics.
  - `injectContext`, `extractContext` and `withContext` helpers.
- **Redaction:** on by default for bodies, headers, query strings, DB parameters, job data and message payloads.
