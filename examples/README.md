# Example observability stack

An OpenTelemetry Collector (OTLP on 4317/4318) fans telemetry out to:

| Signal  | Backend                      | UI                      |
| ------- | ---------------------------- | ----------------------- |
| Traces  | Tempo and Jaeger             | Grafana, <http://localhost:16686> |
| Logs    | Loki (OTLP)                  | Grafana                 |
| Metrics | Prometheus (remote write)    | Grafana, <http://localhost:9090> |

Grafana (<http://localhost:3000>, anonymous admin) has Tempo, Loki and Prometheus provisioned, with
Tempo -> Loki trace-to-logs and Loki -> Tempo derived-field links.

## Run it

```bash
docker compose -f examples/docker-compose.yml up -d
```

Then start any Nest app that uses the library. To use the e2e fixture app (from the repo root):

```bash
pnpm test:e2e   # builds the fixture into <os tmpdir>/oxth-nestjs-otel-e2e-<hash>/fixture
cd "$(ls -d "${TMPDIR:-/tmp}"/oxth-nestjs-otel-e2e-*/fixture | head -n 1)"
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=fixture \
LOGGER=nest \
PORT=3001 \
node --import @oxth/nestjs-otel/register esm/entry-esm.js
```

The app listens on port 3001 (Grafana already has 3000). Call it, then look at the data in Grafana > Explore:

```bash
curl localhost:3001/users/1
curl localhost:3001/users/500   # an error: recorded on the span
```

`LOGGER=nest` wires `OtelLogger`, so log lines carry `trace_id` and show up in Loki next to the trace.
Stop the stack with `docker compose -f examples/docker-compose.yml down`.
