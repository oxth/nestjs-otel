# @oxth/nestjs-otel — Plan 4: Microservice Transports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A request that crosses a Nest microservice hop stays one trace. Example: `GET /ms/users/1` → `MsClientService.get` → `send users.get` → (TCP, Redis, Kafka, RabbitMQ or SQS) → `UsersMsController.get`. This works on Nest 11 and 12, with redacted payloads on failure, handler metrics, and manual helpers for custom transports.

**Architecture:**
- **Bootstrap layer.** These official instrumentations join the registry, with values kept out by default: `kafkajs`, `amqplib`, `ioredis`, `redis` and `aws-sdk`. Kafka, RabbitMQ and SQS carry W3C context in message headers/attributes through these instrumentations.
- **Nest layer, applied from `OtelModule`.** The spec forbids patching Nest from outside DI. `OtelModule` patches `@nestjs/microservices` prototypes once in three places:
  1. `ClientProxy.prototype.send`/`emit` get a client span. The caller's context is captured at call time, which fixes the parked "Observable subscribe context" item.
  2. `ClientTCP`/`ClientRedis` `publish`/`dispatchEvent` write the W3C carrier into `packet.metadata`. Nest 12 exposes that field as `ctx.getMetadata()`; Nest 11 ignores it.
  3. `ServerTCP`/`ServerRedis` `handleMessage` read `metadata` and run the original inside the extracted context.

  The same code works on Nest 11 (no dispatch/processing hooks) and Nest 12. We don't use Nest 12's `setOnDispatchHook`/`setOnProcessingStartHook`, because they are per-instance and the app may own them.
- **Handler spans.** Plan 1 already wraps controller methods as `Class.method`. For methods carrying `@MessagePattern`/`@EventPattern` metadata, the wrapper gains:
  - the kind (SERVER/CONSUMER);
  - messaging attributes taken from the RPC context argument;
  - payload capture on failure;
  - handler metrics.

  `@ssut/nestjs-sqs` handlers are recognised by their method metadata. Their span starts from the context in the SQS message attributes; batch handlers get links instead.
- **Manual helpers.** `injectContext` / `extractContext` / `withContext` for custom transports.

**Tech Stack:**
- Existing stack.
- Instrumentations: `@opentelemetry/instrumentation-kafkajs` 0.33, `-amqplib` 0.71, `-ioredis` 0.72, `-redis` 0.72, `-aws-sdk` 0.79.
- Dev and fixture: `@nestjs/microservices` (already a dev dep), `kafkajs` 2.2, `amqplib` + `amqp-connection-manager` 5, `ioredis` 5, `@ssut/nestjs-sqs` 3 with `@aws-sdk/client-sqs` 3.
- Docker: testcontainers `@testcontainers/kafka` (KRaft), `rabbitmq:4`, `softwaremill/elasticmq-native` (SQS), plus `redis:8` (exists).

**Spec:** `docs/superpowers/specs/2026-10-28-nestjs-otel-design.md`:
- §5.2 microservice handlers;
- §5.3 `RpcException` is an error;
- §5.4 payload redaction;
- §5.5 microservice metrics;
- §6 the Kafka/RabbitMQ/Redis/TCP/SQS/manual rows, propagation, and envelope transports, which must stay wire-compatible with plain Nest.

Plans 1–3 are merged on `main`. Read `README.md`, `src/module/auto-instrument.ts`, `src/tracing/wrap.ts`, `src/queue/settings.ts` and `src/bootstrap/instrumentations.ts` for current names.

## Global Constraints

- **Plans 1–3 constraints still apply:**
  - telemetry never throws into app code (`safely`);
  - scope `@oxth/nestjs-otel`;
  - config only from standard env vars;
  - censor `[REDACTED]`;
  - Nest-layer patching only from `OtelModule`.
- **Supported:** `@nestjs/microservices ^11 || ^12` (existing optional peer). Transports in scope: TCP, Redis, Kafka, RabbitMQ, SQS (`@ssut/nestjs-sqs` `>=3 <4`). NATS, MQTT and gRPC get only the generic client span and handler span, with no envelope propagation. The README says so.
- **New instrumentation names**, each `{name, pkg}`:
  - `kafkajs` (pkg `kafkajs`);
  - `amqplib` (pkg `amqplib`);
  - `ioredis` (pkg `ioredis`);
  - `redis` (pkg `redis`);
  - `aws-sdk` (pkg `@aws-sdk/client-sqs`).

  Defaults:
  - `ioredis` and `redis`: `requireParentSpan: true`, and a statement serializer that returns the **command name only** (no keys, no values).
  - `aws-sdk`: `sqsExtractContextPropagationFromPayload: false`.
  - `kafkajs` and `amqplib`: upstream defaults, which record no payloads.
- **Envelope (TCP, Redis):**
  - The carrier is written as top-level keys of `packet.metadata` (`traceparent`, optional `tracestate`, `baggage`), produced by `propagation.inject`.
  - If `packet.metadata` is an existing plain object, keys are added to it without overwriting existing keys. If it is any other non-nullish value, nothing is injected.
  - `packet.pattern` and `packet.data` are never touched.
  - The server reads the carrier from the incoming packet's `metadata`.
  - **Redis:** parse only when the raw message contains the substring `traceparent`.
  - **TCP:** the JSON socket already delivers objects.
- **Client span:**
  - Name: `send ${pattern}` (kind CLIENT) for `send()`, `emit ${pattern}` (kind PRODUCER) for `emit()`.
  - Attributes: `messaging.system`, `messaging.destination.name = pattern`, `messaging.operation.type = 'send'`, `nestjs.microservice.kind = 'message' | 'event'`.
  - For `send()` the span starts at subscription in the context captured when `send()` was called, and ends on complete, error or unsubscribe. For `emit()` it starts at the call.
  - Errors from the server are recorded with `recordError` and Plan 1 classification.
- **Pattern string:** a string pattern as-is, otherwise `JSON.stringify` with keys sorted recursively. Helper: `patternToString(p)`.
- **`messaging.system` by transport:**
  - from the client class: `ClientTCP` → `tcp`, `ClientRedis` → `redis`, `ClientKafka` → `kafka`, `ClientRMQ` → `rabbitmq`, `ClientNats` → `nats`, `ClientMqtt` → `mqtt`, `ClientGrpcProxy` → `grpc`, otherwise `nestjs`;
  - from the context class: `TcpContext`, `RedisContext`, `KafkaContext`, `RmqContext`, `NatsContext`, `MqttContext` map the same way;
  - SQS: `aws_sqs`.
- **Handler span:** the existing `Class.method` span. For methods with `microservices:pattern` metadata:
  - Kind: SERVER when `microservices:handler_type` is 1 (MESSAGE), CONSUMER when it is 2 (EVENT).
  - Attributes: `messaging.system`, `messaging.destination.name`, `messaging.operation.type = 'process'`, `nestjs.microservice.kind`, `nestjs.microservice.pattern`.
  - The destination is `ctx.getPattern?.()` (`getTopic()` for Kafka), falling back to the first metadata pattern.
- **SQS handler span:** for methods with `Symbol.for('SQS_CONSUMER_METHOD')` metadata:
  - Kind CONSUMER, name `Class.method`.
  - Attributes: `messaging.system = 'aws_sqs'`, `messaging.destination.name` = the consumer `name` from metadata, `messaging.operation.type = 'process'`, `messaging.message.id = message.MessageId`.
  - Parent: extracted from `message.MessageAttributes` (`{ traceparent: { StringValue } }`, and the same for `tracestate`/`baggage`).
  - Batch handlers (`batch: true`): no parent, plus one span link per message that carries context, and `messaging.batch.message_count`.
- **Payload capture:**
  - `OtelModule.forRoot({ microservices: { captureData, maxDataBytes } })`, with `captureData` `'error' | 'always' | 'never'` (default `'error'`) and `maxDataBytes` (default `8192`).
  - Attribute `nestjs.microservice.data`, plus `nestjs.microservice.data.truncated`, set on the handler span only.
  - The value is the handler's first argument: the message data, or the SQS message `Body`.
  - Redacted with the default redactor through `serializeBody`.
  - Responses are never recorded.
- **Handler metrics** (meter `@oxth/nestjs-otel`; recorded for both pattern handlers and SQS handlers):
  - Base attributes: `messaging.system`, `messaging.destination.name`, `messaging.operation.name = 'process'`.
  - `messaging.process.duration` histogram, unit `s`, the same bucket boundaries as BullMQ's, plus `error.type` on failure.
  - `nestjs.microservice.handler.errors` counter on failure.
- **Option:** `autoInstrument.microservices` (default `true`) turns off the client, server and envelope patches. Handler spans still follow `autoInstrument.controllers`.
- **Manual helpers**, exported from the package root:
  - `injectContext(carrier: Record<string, unknown>, ctx?: Context): typeof carrier` (string values, through the global propagator);
  - `extractContext(carrier: Record<string, unknown> | undefined, base?: Context): Context`;
  - `withContext<T>(ctx: Context, fn: () => T): T`.

  They never throw. Invalid input returns the carrier unchanged, or `base ?? context.active()`.

## Review Focus

1. **Wire compatibility with plain Nest.** A packet from the library must be handled by an unpatched Nest server with `data` exactly as sent. An unpatched client must work against a patched server: no metadata gives a new root and no error. Test: Task 3 `unpatched server receives data unchanged` and `unpatched client → patched server`.
2. **A `send()` Observable subscribed later or elsewhere** (`firstValueFrom` inside another async step, or `lastValueFrom` after an `await`) must still parent to the span that was active when `send()` was called. Test: Task 3 `context captured at send() time`.
3. **A secret in a message payload** (`password`) must never reach an exported span when the handler succeeds, and appears only as `[REDACTED]` when it fails. This holds for all five transports. Test: Task 6 `secret never leaks` per transport.
4. **Redis command spans don't flood traces.** With `ioredis` instrumented, an idle Redis transport server and idle BullMQ workers produce no root spans, and command spans carry no keys or values. Test: Task 2 `ioredis defaults` (unit), Task 6 `redis: idle server records no spans`.
5. **An app that sets its own `packet.metadata`** through Nest 12's `setOnDispatchHook` keeps its values; our keys are only added. Test: Task 3 `existing metadata is preserved`.

## File Structure

```
src/
  propagation/helpers.ts           injectContext, extractContext, withContext
  microservices/pattern.ts         patternToString, systemOfClient, systemOfContext
  microservices/settings.ts        MicroservicesOptions/Settings, resolve/get/setMicroservicesSettings
  microservices/client.ts          patchClients/unpatchClients (ClientProxy send/emit; TCP/Redis envelope inject)
  microservices/server.ts          patchServers/unpatchServers (TCP/Redis envelope extract)
  microservices/handler.ts         describeHandler(owner, name) → handler wrap options (kind, dynamic attrs, metrics, payload)
  microservices/sqs.ts             describeSqsHandler(owner, name) → wrap options (parent/links from attributes)
  microservices/install.ts         instrumentMicroservices(opts): dynamic import of @nestjs/microservices, patch once
  tracing/wrap.ts                  WrapOptions += describe (modify)
  module/auto-instrument.ts        use describeHandler/describeSqsHandler for controller/provider methods (modify)
  module/options.ts, otel.module.ts, shared/global-state.ts, index.ts   (modify)
  bootstrap/config.ts, bootstrap/instrumentations.ts                   (modify)
test/
  unit/propagation-helpers.test.ts, unit/pattern.test.ts, unit/instrumentations.test.ts (modify)
  integration/microservices-tcp.test.ts        in-process Nest TCP microservice (no Docker)
  integration/microservices-handler.test.ts    handler spans, metrics, payload, SQS handler via fakes
  db/helpers/containers.ts (modify)            + kafka, rabbitmq, elasticmq
  db/microservices.db.test.ts                  spawned fixture per transport
  e2e/fixture/src/ms/…                         TRANSPORT-selected hybrid app
README.md  .github/workflows/ci.yml  package.json
```

---

### Task 1: Manual propagation helpers and pattern utilities

**Files:**
- Create: `src/propagation/helpers.ts`, `src/microservices/pattern.ts`
- Modify: `src/index.ts`
- Test: `test/unit/propagation-helpers.test.ts`, `test/unit/pattern.test.ts`

**Interfaces:**
- Produces:
  - `injectContext`, `extractContext`, `withContext` (signatures in Global Constraints).
  - `patternToString(p: unknown): string`.
  - `systemOfClient(client: object): string`.
  - `systemOfContext(ctx: unknown): string | undefined`.

  Both `systemOf*` functions match on `constructor.name`; there are no imports from `@nestjs/microservices`.

- [ ] **Step 1: Write the failing tests.** Use in-memory tracing and the W3C propagator.
  - `inject then extract round-trips the active span`: inside span S, `extractContext(injectContext({}))` has S's trace and span ids.
  - `injectContext keeps existing keys and returns the same object`.
  - `extractContext(undefined)` and `extractContext({traceparent: 42})` return `context.active()`, or `base` when given.
  - `withContext runs fn in ctx and returns its value`, and a thrown error propagates unchanged.
  - `never throws`: with the propagator replaced by one whose `inject`/`extract` throw, the helpers return their fallbacks.
  - `patternToString`:
    - `'users.get'` gives `'users.get'`;
    - `{ b: 1, a: { d: 2, c: 3 } }` gives `'{"a":{"c":3,"d":2},"b":1}'`;
    - a circular object gives `'[object Object]'` and doesn't throw.
  - `systemOfClient` and `systemOfContext` map every class name in Global Constraints. Use fake classes named the same, e.g. `class ClientTCP {}`. Unknown classes give `'nestjs'` and `undefined` respectively.

- [ ] **Step 2: Run** `pnpm vitest run test/unit/propagation-helpers.test.ts test/unit/pattern.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and export the three helpers from `src/index.ts`.
- [ ] **Step 4: Run** the tests, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add context propagation helpers`.

---

### Task 2: Transport instrumentations in the bootstrap registry

**Files:**
- Modify: `src/bootstrap/config.ts`, `src/bootstrap/instrumentations.ts`, `package.json`
- Test: `test/unit/instrumentations.test.ts`

**Interfaces:**
- Produces: five registry entries (names and packages in Global Constraints).

- [ ] **Step 1: Write the failing tests:**
  - each name is included when its package is installed and excluded by `OTEL_NODE_DISABLED_INSTRUMENTATIONS`;
  - `ioredis defaults`: the created `IORedisInstrumentation`'s config has `requireParentSpan: true`, and its `dbStatementSerializer('set', ['user:1', 'hunter2'])` returns `'set'`;
  - the same for `redis` (the `RedisInstrumentation` config's serializer returns the command name);
  - `aws-sdk` has `sqsExtractContextPropagationFromPayload: false`.
- [ ] **Step 2: Run** `pnpm vitest run test/unit/instrumentations.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the five instrumentation packages as dependencies, at the versions in Tech Stack. Check each instrumentation's README for its exact config option names; if a name differs from the ones above, use the upstream name and keep the behaviour.
- [ ] **Step 4: Run** the tests, then `pnpm typecheck && pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: instrument kafkajs, amqplib, redis clients and AWS SDK`.

---

### Task 3: Client spans and the TCP/Redis envelope

**Files:**
- Create: `src/microservices/client.ts`, `src/microservices/server.ts`, `src/microservices/install.ts`
- Modify: `src/module/options.ts` (`autoInstrument.microservices`), `src/module/otel.module.ts`, `src/shared/global-state.ts` (patched marker)
- Test: `test/integration/microservices-tcp.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `recordError`, `getClassifyDefaults`.
- Produces:
  - `patchClients(ms: any)` / `unpatchClients(ms: any)`.
  - `patchServers(ms: any)` / `unpatchServers(ms: any)`.
  - `instrumentMicroservices(opts: ResolvedOtelOptions): Promise<void>`. It loads `@nestjs/microservices` with a dynamic `import()` (`require` in the CJS build, following how the build handles other optional peers), returns quietly when the package is absent, patches once per process (global-state marker), and does nothing when `autoInstrument.microservices` is false.
  - `OtelModule` awaits it in its existing provider factory, before `instrumentApplication`.

- [ ] **Step 1: Write the failing tests.** Run in-process with a real Nest 12 TCP microservice:
  - `Test.createTestingModule` with a `@Controller` that has `@MessagePattern('users.get')` and `@EventPattern('user.created')`;
  - `app.connectMicroservice({ transport: Transport.TCP, options: { port: 0 } })`, or a free port helper;
  - a client from `ClientProxyFactory.create({ transport: Transport.TCP, options: { port } })`;
  - in-memory tracing, the W3C propagator, and `patchClients`/`patchServers` called directly.

  Tests:
  - `send: client span parents the server side`. Inside span `caller`, `await lastValueFrom(client.send('users.get', {id: 1}))`. Expected:
    - span `send users.get`: kind CLIENT, parent `caller`, `messaging.system='tcp'`, `messaging.destination.name='users.get'`;
    - the handler's `Class.method` span is in the same trace, with parent `send users.get`.
  - `emit: producer span`: `emit user.created` with kind PRODUCER, and the event handler span is its child.
  - `context captured at send() time`. Do `const obs = client.send(...)` inside `caller`, end `caller`, then outside any span do `await new Promise(r => setTimeout(r, 10))` followed by `await lastValueFrom(obs)`. `send users.get` still has parent `caller`.
  - `server error is recorded on the client span`: a handler throwing `new RpcException('nope')` gives a client span with ERROR status and the observable errors as before.
  - `unpatched server receives data unchanged`. Call `unpatchServers(ms)`, keep the clients patched, and send `{id: 1, nested: {a: [1]}}`. The handler receives deep-equal data, and the reply arrives.
  - `unpatched client → patched server`. Call `unpatchClients(ms)` and keep the servers patched. The call works and the handler span is a root, with no error.
  - `existing metadata is preserved`. Use `client.setOnDispatchHook(p => { p.metadata = { tenant: 't1' } })` (Nest 12 only; `it.runIf` when the method exists). The handler's `ctx.getMetadata()` contains `tenant: 't1'` and a `traceparent`.
  - `non-object metadata is left alone`: with a hook setting `p.metadata = 'x'`, the call works and `getMetadata()` is `'x'`.
  - `autoInstrument.microservices: false` patches nothing: `instrumentMicroservices(resolveOptions({autoInstrument:{microservices:false}}))` leaves `ClientProxy.prototype.send` unchanged.
- [ ] **Step 2: Run** `pnpm vitest run test/integration/microservices-tcp.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Client:**
    - `send` is wrapped: capture `context.active()`, then return `new Observable(sub => context.with(ctx, () => startActiveSpan(...)))`. Subscribe to the original inside it, end the span exactly once, and tear down on unsubscribe.
    - `emit` is wrapped the same way, but the span starts immediately, because the original connects eagerly.
    - TCP/Redis `publish(packet, cb)` / `dispatchEvent(packet)` inject into `packet.metadata` per the Global Constraints, then call the original.
  - **Server:** `ServerTCP.prototype.handleMessage(socket, raw)` and `ServerRedis.prototype.handleMessage(channel, buffer, pub, pattern)` extract from `raw.metadata` (for Redis, `this.parseMessage(buffer)` when the text contains `traceparent`) and run the original inside `context.with(extracted, …)`.
  - Every step runs in `safely`, and the originals are called exactly once with the same arguments.
- [ ] **Step 4: Run** the tests. Expected: PASS. Then run `pnpm typecheck && pnpm test`, followed by `NEST_VERSION=11 pnpm test:e2e`. That doesn't run this file, but it guards the module wiring on Nest 11.
- [ ] **Step 5: Commit** `feat: trace Nest microservice clients and propagate over TCP/Redis`.

---

### Task 4: Handler spans, payload capture and metrics

**Files:**
- Create: `src/microservices/handler.ts`, `src/microservices/settings.ts`
- Modify: `src/tracing/wrap.ts`, `src/module/auto-instrument.ts`, `src/module/options.ts`, `src/module/otel.module.ts`, `src/shared/global-state.ts`, `src/index.ts` (export the `MicroservicesOptions` type)
- Test: `test/integration/microservices-handler.test.ts`, plus extending `test/integration/microservices-tcp.test.ts`

**Interfaces:**
- Consumes: `patternToString`, `systemOfContext` (Task 1); `serializeBody`, `getDefaultRedactor`; the BullMQ duration bucket boundaries (export them from `src/queue/process-job.ts` as `DURATION_BUCKETS_SECONDS` and reuse them).
- Produces:
  - `WrapOptions.describe?: (args: unknown[]) => CallDescription | undefined`, where `CallDescription = { attributes?: Attributes; links?: Link[]; parent?: Context; onSettled?: (span: Span, error: unknown | undefined, durationSeconds: number) => void }`.
  - In `wrapMethod`, `describe` is called once per call inside `safely`. Its `parent` (if any) is the context the span starts in, `attributes` and `links` go into the span options, and `onSettled` runs once when the result settles, through the existing `ResultHooks`.
  - `describeHandler(owner: object, name: string): Pick<WrapOptions, 'kind' | 'describe'> | undefined`. It returns `undefined` for methods without `microservices:pattern` metadata.
  - `microservices` settings mirroring `src/queue/settings.ts`.

- [ ] **Step 1: Write the failing tests** in `microservices-handler.test.ts`. Use the Nest TestingModule with `OtelModule.forRoot()` and controllers whose handlers are called directly through the wrapped prototype with fake context objects (`class TcpContext { getPattern() { return 'users.get' } }`, and `class KafkaContext { getTopic() { return 'orders' } }`).
  - `message handler`: kind SERVER, `messaging.system='tcp'`, `messaging.destination.name='users.get'`, `messaging.operation.type='process'`, `nestjs.microservice.kind='message'`, `nestjs.microservice.pattern='users.get'`.
  - `event handler`: kind CONSUMER, `nestjs.microservice.kind='event'`.
  - `kafka destination comes from getTopic()`.
  - `object pattern`: `@MessagePattern({ cmd: 'sum' })` gives a destination of `'{"cmd":"sum"}'` when the context has no `getPattern`.
  - `plain controller methods are unchanged`: an HTTP handler span keeps kind INTERNAL and gets no messaging attributes.
  - `failure`:
    - The handler throws `new RpcException('bad')` with data `{password: 'p', a: 1}`.
    - The span has ERROR status, one exception event, and `nestjs.microservice.data` containing `[REDACTED]` and not `"p"`.
    - `nestjs.microservice.handler.errors` is 1.
    - A `messaging.process.duration` point exists with `error.type='RpcException'`.
  - `success records duration, no data`. With `captureData: 'always'`, data is recorded; with `'never'`, it never is. `maxDataBytes: 8` sets `truncated`.
  - `observable handler`: a handler returning `of(1, 2)` records its duration when the stream completes, not before.

  In `microservices-tcp.test.ts`, add `handler span is SERVER with messaging attributes over real TCP`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `instrumentClass` calls `describeHandler` for controller methods and merges `kind` and `describe` into the `wrapMethod` options.
  - The RPC context is the last argument that `systemOfContext` recognises.
  - Settings are wired in `OtelModule` next to `setBullmqSettings`.
- [ ] **Step 4: Run** the tests, then `pnpm typecheck && pnpm test && pnpm test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: microservice handler spans, payload capture and metrics`.

---

### Task 5: `@ssut/nestjs-sqs` consumer context

**Files:**
- Create: `src/microservices/sqs.ts`
- Modify: `src/module/auto-instrument.ts`
- Test: `test/integration/microservices-handler.test.ts` (extend)

**Interfaces:**
- Consumes: `extractContext` (Task 1); `WrapOptions.describe` (Task 4).
- Produces: `describeSqsHandler(owner, name)`. It reads `Reflect.getMetadata(Symbol.for('SQS_CONSUMER_METHOD'), owner[name])`, whose shape is `{ name: string, batch?: boolean }`; check this against `@ssut/nestjs-sqs` 3.x's `sqs.decorators.js`. It is applied to **provider** methods as well as controllers.

- [ ] **Step 1: Write the failing tests.** Use a provider whose method carries the metadata, set directly with `SetMetadata(Symbol.for('SQS_CONSUMER_METHOD'), { name: 'orders' })`, so no SQS package is needed. Call it through the wrapped prototype.
  - `single message: parent comes from MessageAttributes`. Build a carrier with `injectContext({})` inside span P, map it to `{ traceparent: { DataType: 'String', StringValue } }`, and call `handler({ MessageId: 'm1', Body: '{"password":"p"}', MessageAttributes })` outside any span. Expected:
    - span `Class.method` with kind CONSUMER and parent P;
    - `messaging.system='aws_sqs'`, `messaging.destination.name='orders'`, `messaging.message.id='m1'`.
  - `no attributes gives a root`.
  - `batch: links`: `{ name: 'orders', batch: true }` with three messages, two of which carry context. Expected: no parent, two links, `messaging.batch.message_count=3`.
  - `failure captures the redacted Body`: the handler throws, and `nestjs.microservice.data` contains `[REDACTED]`, not `p`. A JSON `Body` is parsed before redaction; a non-JSON body is redacted as a string.
  - `metadata survives wrapping`: `Reflect.getMetadata(Symbol.for('SQS_CONSUMER_METHOD'), wrapped)` still returns the object, so `@ssut/nestjs-sqs` discovery keeps working.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `pnpm typecheck && pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: continue traces in @ssut/nestjs-sqs handlers`.

---

### Task 6: All transports against real brokers (Docker suite)

**Files:**
- Modify:
  - `test/db/helpers/containers.ts`: add Kafka (via `@testcontainers/kafka`, KRaft), `rabbitmq:4`, and `softwaremill/elasticmq-native` (port 9324). `DbUrls` gains `kafka` (brokers `host:port`), `amqp`, `sqs` (endpoint URL).
  - `test/e2e/fixture/package.json` and `test/e2e/global-setup.ts`: `@nestjs/microservices` follows `NEST_VERSION`. Add `kafkajs`, `amqplib`, `amqp-connection-manager`, `@ssut/nestjs-sqs` and `@aws-sdk/client-sqs`.
  - `test/e2e/fixture/src/app.module.ts` and `bootstrap.ts`: `loadMsModule()` selected by `TRANSPORT=tcp|redis|kafka|rmq|sqs`.
- Create:
  - `test/e2e/fixture/src/ms/`: a static `MsModule` per transport, built by a factory like `createTypeormDbModule`.
  - `test/db/microservices.db.test.ts`.

**The fixture is one hybrid app.**
- It calls `app.connectMicroservice(...)` for the selected transport (and `startAllMicroservices()`), and registers a client to itself with `ClientsModule`.
- **Routes:**
  - `GET /ms/users/:id` calls `MsClientService.get`, which calls `client.send('users.get', {id})`.
  - `POST /ms/events` calls `MsClientService.created(body)`, which calls `client.emit('user.created', body)`.
  - `POST /ms/fail` calls `client.send('users.fail', body)`; that handler throws `RpcException`.
- **Handlers:** in `UsersMsController`. On Kafka, the request-reply pattern needs `client.subscribeToResponseOf('users.get')` / `('users.fail')` in `onModuleInit`.
- **SQS:**
  - routes `POST /ms/events` and `POST /ms/fail` send through `SqsService.send('orders', { id, body })`;
  - the handler is `@SqsMessageHandler('orders')` on `OrdersSqsHandler`, and throws when `body.fail`;
  - the fixture creates the queue on start (`CreateQueueCommand`);
  - `GET /ms/users/:id` is not used for SQS.

- [ ] **Step 1: Write the tests.** Use `describe.each(['tcp', 'redis', 'kafka', 'rmq', 'sqs'])`, with the `esm` entry (preload) for all transports plus a `cjs` run for `tcp`.
  - `trace chain` (not SQS):
    - `GET /ms/users/1` returns 200.
    - Spans: `MsClientService.get`, then `send users.get` (parent `MsClientService.get`), then `UsersMsController.get` (kind SERVER) in the same trace.
    - For Kafka and RMQ, the broker instrumentation's producer and consumer spans may sit in between. Assert same trace and ancestry, not the direct parent.
  - `event chain`: `POST /ms/events` gives the event handler span (CONSUMER) in the trace of `emit user.created`. For SQS it is the `OrdersSqsHandler` span in the HTTP trace.
  - `secret never leaks`:
    - Success: `POST /ms/events {password: SECRET}`. After the handler span ends, SECRET is absent from all spans.
    - Failure: `POST /ms/fail {password: SECRET}`. The handler span has ERROR status and `nestjs.microservice.data` containing `[REDACTED]`, and SECRET is absent from all spans.
  - `redis: idle server records no spans`: start with `TRANSPORT=redis`, wait 3 s with no requests, and expect no spans with `db.system.name` or `db.system` equal to `redis`.
  - `handler metrics exported`: `messaging.process.duration` with `messaging.destination.name='users.get'` (or `'orders'` for SQS).
- [ ] **Step 2: Run** `REQUIRE_DOCKER=1 pnpm test:db`, then `NEST_VERSION=11 TYPEORM_VERSION=^0.3 MIKRO_VERSION=^6 BULLMQ_VERSION=5.24.0 REQUIRE_DOCKER=1 pnpm test:db`. Expected: PASS. Fix the library, not the expectations, when a Global Constraint fails.
- [ ] **Step 3: Commit** `test: microservice transports against real brokers`.

---

### Task 7: README and CI

**Files:**
- Modify: `README.md`, `.github/workflows/ci.yml`, `test/unit/readme.test.ts` (if it guards option names)

- [ ] **Step 1: Write the README "Microservices" section,** after "Queues (BullMQ)":
  - supported transports and versions;
  - what a trace looks like, as the chain from Task 6;
  - how context travels per transport: `metadata` envelope on TCP/Redis (safe for plain Nest services; Nest 12 apps see it in `ctx.getMetadata()`), headers on Kafka/RabbitMQ, message attributes on SQS;
  - handler span attributes;
  - payload capture (`microservices.captureData`, `maxDataBytes`, with a `forRoot` example), and that responses are never recorded;
  - metrics;
  - the Redis command spans' defaults (only inside a trace, command name only);
  - manual helpers, with an example for a custom transport;
  - `autoInstrument.microservices`;
  - disabling instrumentations by name;
  - limits:
    - NATS/MQTT/gRPC get no propagation;
    - RabbitMQ through `amqp-connection-manager`: messages published while the channel's send queue is busy are sent later from its worker loop, so their publish span may lose its parent;
    - SQS batch handlers use links;
    - an app's non-object `packet.metadata` disables injection.

  Add the new env-free config rows to the config reference.
- [ ] **Step 2: Update CI.** The db job needs no new matrix axis, but its containers now include Kafka, RabbitMQ and ElasticMQ; raise its `timeout-minutes` if one is set.
- [ ] **Step 3: Run** `pnpm vitest run test/unit/readme.test.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 4: Commit** `docs: microservices`.
