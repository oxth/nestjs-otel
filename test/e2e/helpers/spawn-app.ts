import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { FIXTURE_DIR } from '../paths';
import type { OtlpReceiver } from './otlp-receiver';

export interface RunningApp {
  port: number;
  stdout(): string;
  stderr(): string;
  get(path: string, init?: RequestInit): Promise<Response>;
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

const ENTRIES = {
  esm: 'esm/entry-esm.js',
  cjs: 'cjs/entry-cjs.js',
  'esm-dynamic': 'esm/entry-esm-dynamic.js',
} as const;

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;

/** Strip anything from the test runner's env that would leak into the child's OTel or Node config. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('OTEL_') || k === 'NODE_OPTIONS' || k.startsWith('VITEST')) continue;
    env[k] = v;
  }
  return env;
}

export function spawnApp(o: {
  entry: 'esm' | 'cjs' | 'esm-dynamic';
  preload?: boolean;
  env?: Record<string, string>;
  receiver: OtlpReceiver;
}): Promise<RunningApp> {
  const args = [...(o.preload ? ['--import', '@oxth/nestjs-otel/register'] : []), join(FIXTURE_DIR, ENTRIES[o.entry])];
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: FIXTURE_DIR,
    env: {
      ...baseEnv(),
      NODE_ENV: 'test',
      OTEL_EXPORTER_OTLP_ENDPOINT: o.receiver.url,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_SERVICE_NAME: 'fixture',
      OTEL_BSP_SCHEDULE_DELAY: '100',
      OTEL_BLRP_SCHEDULE_DELAY: '100',
      OTEL_METRIC_EXPORT_INTERVAL: '500',
      ...o.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

  let started = false;
  return new Promise<RunningApp>((resolve, reject) => {
    const fail = (why: string): void => {
      clearInterval(poll);
      child.kill('SIGKILL');
      reject(new Error(`fixture ${o.entry} ${why}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
    };
    const timer = setTimeout(() => fail(`did not start within ${START_TIMEOUT_MS}ms`), START_TIMEOUT_MS);
    void exited.then((code) => {
      if (started) return;
      clearTimeout(timer);
      fail(`exited early with code ${code}`);
    });
    const poll = setInterval(() => {
      const m = /listening:(\d+)/.exec(stdout);
      if (!m) return;
      started = true;
      clearInterval(poll);
      clearTimeout(timer);
      const port = Number(m[1]);
      let stopped: Promise<number | null> | undefined;
      resolve({
        port,
        stdout: () => stdout,
        stderr: () => stderr,
        get: (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init),
        stop(signal = 'SIGTERM') {
          stopped ??= (() => {
            const kill = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
            child.kill(signal);
            return exited.finally(() => clearTimeout(kill));
          })();
          return stopped;
        },
      });
    }, 20);
  });
}
