import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FIXTURE_DIR, FIXTURE_SRC_DIR, ROOT_DIR, TMP_DIR } from './paths';

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/**
 * Builds and packs the library, then installs the fixture app from the tarball into
 * test/e2e/.tmp/fixture (its own pnpm project, so there is exactly one @nestjs/core)
 * and compiles it into esm/ and cjs/.
 */
export default function setup(): void {
  const nestVersion = process.env.NEST_VERSION ?? '12';

  run('pnpm', ['build'], ROOT_DIR);
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  run('pnpm', ['pack', '--pack-destination', TMP_DIR], ROOT_DIR);
  const tarball = readdirSync(TMP_DIR).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error(`pnpm pack produced no tarball in ${TMP_DIR}`);

  cpSync(FIXTURE_SRC_DIR, FIXTURE_DIR, { recursive: true });
  const pkgPath = join(FIXTURE_DIR, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const name of Object.keys(pkg.dependencies)) {
    if (name.startsWith('@nestjs/')) pkg.dependencies[name] = nestVersion;
  }
  pkg.dependencies['@oxth/nestjs-otel'] = `file:${relative(FIXTURE_DIR, join(TMP_DIR, tarball))}`;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  run('pnpm', ['install', '--ignore-workspace', '--prefer-offline', '--config.lockfile=false', '--reporter=silent'], FIXTURE_DIR);

  const tsc = join(ROOT_DIR, 'node_modules/.bin/tsc');
  for (const [format, type] of [['esm', 'module'], ['cjs', 'commonjs']] as const) {
    run(tsc, ['-p', `tsconfig.${format}.json`], FIXTURE_DIR);
    writeFileSync(join(FIXTURE_DIR, format, 'package.json'), `${JSON.stringify({ type })}\n`);
  }
}
