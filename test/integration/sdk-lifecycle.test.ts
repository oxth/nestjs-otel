import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';
import { beforeAll, describe, expect, it } from 'vitest';
import { startOtlpReceiver } from '../e2e/helpers/otlp-receiver';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '.tmp/bootstrap');

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function run(
  script: string,
  env: Record<string, string> = {},
  opts: { killOn?: string; signal?: NodeJS.Signals; timeoutMs?: number } = {},
): Promise<RunResult & { elapsedAfterSignal?: number }> {
  const child = spawn(process.execPath, [join(here, 'scripts', script)], {
    env: { ...process.env, NODE_ENV: '', OTEL_LOG_LEVEL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let signalledAt: number | undefined;
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    stdout += d;
    if (opts.killOn && signalledAt === undefined && stdout.includes(opts.killOn)) {
      signalledAt = Date.now();
      child.kill(opts.signal ?? 'SIGTERM');
    }
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 15000);
  return once(child, 'exit').then(([code, signal]) => {
    clearTimeout(timer);
    return {
      code,
      signal,
      stdout,
      stderr,
      elapsedAfterSignal: signalledAt === undefined ? undefined : Date.now() - signalledAt,
    };
  });
}

const noExport = { OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none' };

describe('sdk lifecycle', () => {
  beforeAll(async () => {
    await build({
      config: false,
      entry: { index: join(here, 'scripts/entry.ts') },
      outDir,
      format: ['esm'],
      platform: 'node',
      target: 'node22',
      dts: false,
      clean: true,
      logLevel: 'error',
      outExtensions: () => ({ js: '.mjs' }),
      external: [/^[^./]/],
    });
  }, 60000);

  it('disabled sdk is a no-op', async () => {
    const r = await run('disabled.mjs', { OTEL_SDK_DISABLED: 'true' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ handle: true, global: true });
  });

  it('startSdk is idempotent', async () => {
    const r = await run('idempotent.mjs', noExport);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ defined: true, same: true, global: true });
  });

  it('sigterm exits when only our listener exists', async () => {
    const r = await run('sigterm.mjs', {}, { killOn: 'ready' });
    expect(r.signal).toBe('SIGTERM');
    expect(r.elapsedAfterSignal).toBeLessThan(6000);
  }, 10000);

  it('nest shutdown hooks still run', async () => {
    const r = await run('nest-hooks.mjs', noExport, { killOn: 'ready' });
    expect(r.stdout.match(/hook/g)).toHaveLength(1);
    expect(r.signal).toBe('SIGTERM');
    expect(r.elapsedAfterSignal).toBeLessThan(6000);
  }, 10000);

  it.each([
    ['with OtelModule', '1'],
    ['register only', '0'],
  ])('telemetry from nest shutdown hooks is exported (%s)', async (_, withModule) => {
    const receiver = await startOtlpReceiver();
    try {
      const r = await run(
        'nest-shutdown-telemetry.mjs',
        {
          WITH_MODULE: withModule,
          OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
          OTEL_METRICS_EXPORTER: 'none',
          OTEL_BSP_SCHEDULE_DELAY: '5000',
          OTEL_BLRP_SCHEDULE_DELAY: '5000',
        },
        { killOn: 'ready' },
      );
      expect(r.stdout.match(/hook/g)).toHaveLength(1);
      expect(r.signal).toBe('SIGTERM');
      expect(r.elapsedAfterSignal).toBeLessThan(6000);
      expect(receiver.spans().map((s) => s.name)).toContain('shutdown-hook-span');
      expect(receiver.logs().map((l) => l.body)).toContain('shutdown-hook-log');
    } finally {
      await receiver.close();
    }
  }, 15000);

  it('does not re-raise the signal when the app listens for it', async () => {
    const r = await run('own-listener.mjs', noExport, { killOn: 'ready' });
    expect(r.stdout.match(/user/g)).toHaveLength(1);
    expect(r.code).toBe(0);
  }, 10000);

  it('exporter failures are rate limited', async () => {
    const r = await run('rate-limit.mjs', {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
      OTEL_BSP_SCHEDULE_DELAY: '50',
      // Isolate the trace exporter: a failing metrics export is a different message
      // (different prefix) and would legitimately get its own line.
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_LOGS_EXPORTER: 'none',
    });
    expect(r.stderr.match(/telemetry export error/g)).toHaveLength(1);
    expect(r.stderr).not.toContain('UnhandledPromiseRejection');
    expect(r.stdout).toContain('done');
    expect(r.code).toBe(0);
  }, 20000);
});
