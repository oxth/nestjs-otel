/**
 * Overhead benchmark: p99 latency of `GET /users/1` on the e2e fixture, baseline vs instrumented.
 * A tracked goal, not a gate: always exits 0. Run with `pnpm bench`.
 *
 * Env: BENCH_CONNECTIONS (50), BENCH_DURATION (20 s), BENCH_WARMUP (5 s), NEST_VERSION (12).
 */
import autocannon from 'autocannon';
import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import globalSetup from '../test/e2e/global-setup';
import { FIXTURE_DIR } from '../test/e2e/paths';

const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 50);
const DURATION = Number(process.env.BENCH_DURATION ?? 20);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 5);

/** Accepts every OTLP request and discards it. */
async function startSink(): Promise<{ url: string; close(): void }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

/** Copy of the compiled fixture whose AppModule does not import OtelModule at all. */
function makeBaselineEntry(): string {
  const dir = join(FIXTURE_DIR, 'esm-baseline');
  cpSync(join(FIXTURE_DIR, 'esm'), dir, { recursive: true });
  const file = join(dir, 'app.module.js');
  const src = readFileSync(file, 'utf8');
  const stubbed = src.replace(/imports:\s*\[\s*OtelModule\.forRoot\(\)\s*\]/, 'imports: []');
  if (stubbed === src) throw new Error('could not stub OtelModule out of the fixture app module');
  writeFileSync(file, stubbed);
  return join(dir, 'entry-esm.js');
}

async function startApp(entry: string, preload: boolean, env: Record<string, string>): Promise<{ port: number; stop(): Promise<void> }> {
  const args = [...(preload ? ['--import', '@oxth/nestjs-otel/register'] : []), entry];
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('OTEL_') && k !== 'NODE_OPTIONS') childEnv[k] = v;
  }
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: FIXTURE_DIR,
    env: { ...childEnv, NODE_ENV: 'production', OTEL_SERVICE_NAME: 'bench', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      out += d;
      const m = /listening:(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.once('exit', (code) => reject(new Error(`fixture exited early with code ${code}`)));
    setTimeout(() => reject(new Error('fixture did not start in 30 s')), 30_000).unref();
  });
  return {
    port,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      }),
  };
}

async function load(port: number, seconds: number): Promise<number> {
  const result = await autocannon({ url: `http://127.0.0.1:${port}/users/1`, connections: CONNECTIONS, duration: seconds });
  return result.latency.p99;
}

async function measure(entry: string, preload: boolean, env: Record<string, string>): Promise<number> {
  const app = await startApp(entry, preload, env);
  try {
    await load(app.port, WARMUP);
    return await load(app.port, DURATION);
  } finally {
    await app.stop();
  }
}

async function main(): Promise<void> {
  globalSetup();
  const sink = await startSink();
  try {
    const p99Baseline = await measure(makeBaselineEntry(), false, { OTEL_SDK_DISABLED: 'true' });
    const p99Instrumented = await measure(join(FIXTURE_DIR, 'esm/entry-esm.js'), true, {
      OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    });
    const overheadPct = Number((((p99Instrumented - p99Baseline) / p99Baseline) * 100).toFixed(1));
    console.log(JSON.stringify({ p99Baseline, p99Instrumented, overheadPct }));
  } finally {
    sink.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(0); // tracked goal, not a gate
  },
);
