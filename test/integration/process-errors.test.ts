import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';
import { beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '.tmp/bootstrap');

async function run(mode: string) {
  const child = spawn(process.execPath, [join(here, 'scripts/uncaught.mjs'), mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  const lines = (kind: string) =>
    stdout
      .split('\n')
      .filter((l) => l.startsWith(`${kind} `))
      .map((l) => JSON.parse(l.slice(kind.length + 1)));
  return { code: code as number | null, stderr, lines };
}

describe('process-level errors', () => {
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

  it('uncaught exception emits fatal log record and process still crashes with code 1', async () => {
    const r = await run('throw');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('kaboom');
    const [log] = r.lines('LOG');
    expect(log.severityNumber).toBe(21);
    expect(log.body).toBe('kaboom');
    expect(log.attributes).toMatchObject({
      'exception.type': 'Error',
      'exception.message': 'kaboom',
      'process.uncaught.origin': 'uncaughtException',
    });
    expect(log.attributes['exception.stacktrace']).toContain('kaboom');
  }, 20000);

  it('unhandled rejection crashes as before and is recorded with origin unhandledRejection', async () => {
    const r = await run('rejection');
    expect(r.code).toBe(1);
    const [log] = r.lines('LOG');
    expect(log.severityNumber).toBe(21);
    expect(log.attributes['exception.message']).toBe('rejected');
    expect(log.attributes['process.uncaught.origin']).toBe('unhandledRejection');
  }, 20000);

  it('records and ends the active span', async () => {
    const r = await run('span');
    expect(r.code).toBe(1);
    expect(r.lines('SPAN')).toEqual([{ name: 'doomed', status: 2, events: ['exception'] }]);
  }, 20000);

  it('does not add uncaughtException/unhandledRejection listeners and is idempotent', async () => {
    const r = await run('listeners');
    expect(r.code).toBe(0);
    expect(r.lines('LISTENERS')).toEqual([{ uncaught: 0, rejection: 0, monitor: 1 }]);
  }, 20000);
});
