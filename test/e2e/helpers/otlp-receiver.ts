import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

export interface FlatSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: number;
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
  events: { name: string; attributes: Record<string, unknown> }[];
}

export interface FlatLog {
  body: unknown;
  severityNumber: number;
  traceId?: string;
  spanId?: string;
  attributes: Record<string, unknown>;
}

export interface OtlpReceiver {
  url: string;
  spans(): FlatSpan[];
  metricNames(): string[];
  metricPoints(name: string): { attributes: Record<string, unknown> }[];
  logs(): FlatLog[];
  /** Attributes of every resource seen in any export request. */
  resources(): Record<string, unknown>[];
  waitFor<T>(fn: () => T | undefined | false, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

type Json = Record<string, any>;

/** Decodes an OTLP JSON `AnyValue`. */
function anyValue(v: Json | undefined): unknown {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('bytesValue' in v) return v.bytesValue;
  if ('arrayValue' in v) return ((v.arrayValue as Json).values ?? []).map(anyValue);
  if ('kvlistValue' in v) return attrs((v.kvlistValue as Json).values);
  return undefined;
}

function attrs(list: Json[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list ?? []) out[kv.key] = anyValue(kv.value);
  return out;
}

/** OTLP JSON ids are hex; tolerate base64 too. Empty ids become undefined. */
function id(v: unknown): string | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  if (/^[0-9a-f]+$/i.test(v)) return v.toLowerCase();
  return Buffer.from(v, 'base64').toString('hex');
}

const POINT_KINDS = ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary'];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      resolve(req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw);
    });
    req.on('error', reject);
  });
}

export async function startOtlpReceiver(): Promise<OtlpReceiver> {
  const spans: FlatSpan[] = [];
  const logs: FlatLog[] = [];
  const metrics = new Map<string, { attributes: Record<string, unknown> }[]>();
  const resources: Record<string, unknown>[] = [];

  const ingest = (signal: string, body: Json): void => {
    if (signal === 'traces') {
      for (const rs of body.resourceSpans ?? []) {
        resources.push(attrs(rs.resource?.attributes));
        for (const ss of rs.scopeSpans ?? []) {
          for (const s of ss.spans ?? []) {
            spans.push({
              name: s.name,
              traceId: id(s.traceId) ?? '',
              spanId: id(s.spanId) ?? '',
              parentSpanId: id(s.parentSpanId),
              kind: Number(s.kind ?? 0),
              status: { code: Number(s.status?.code ?? 0), message: s.status?.message || undefined },
              attributes: attrs(s.attributes),
              events: (s.events ?? []).map((e: Json) => ({ name: e.name, attributes: attrs(e.attributes) })),
            });
          }
        }
      }
    } else if (signal === 'metrics') {
      for (const rm of body.resourceMetrics ?? []) {
        resources.push(attrs(rm.resource?.attributes));
        for (const sm of rm.scopeMetrics ?? []) {
          for (const m of sm.metrics ?? []) {
            const points = metrics.get(m.name) ?? [];
            for (const kind of POINT_KINDS) {
              for (const p of m[kind]?.dataPoints ?? []) points.push({ attributes: attrs(p.attributes) });
            }
            metrics.set(m.name, points);
          }
        }
      }
    } else if (signal === 'logs') {
      for (const rl of body.resourceLogs ?? []) {
        resources.push(attrs(rl.resource?.attributes));
        for (const sl of rl.scopeLogs ?? []) {
          for (const r of sl.logRecords ?? []) {
            logs.push({
              body: anyValue(r.body),
              severityNumber: Number(r.severityNumber ?? 0),
              traceId: id(r.traceId),
              spanId: id(r.spanId),
              attributes: attrs(r.attributes),
            });
          }
        }
      }
    }
  };

  const server = createServer((req, res) => {
    const match = /^\/v1\/(traces|metrics|logs)$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !match) {
      res.writeHead(404).end();
      return;
    }
    readBody(req).then(
      (buf) => {
        try {
          ingest(match[1], JSON.parse(buf.toString('utf8')));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' }).end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      },
      () => res.writeHead(500).end(),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    spans: () => [...spans],
    metricNames: () => [...metrics.keys()],
    metricPoints: (name) => [...(metrics.get(name) ?? [])],
    logs: () => [...logs],
    resources: () => [...resources],
    async waitFor<T>(fn: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = fn();
        if (value !== undefined && value !== false) return value as T;
        if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
