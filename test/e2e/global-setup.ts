import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FIXTURE_DIR, FIXTURE_SRC_DIR, ROOT_DIR, TMP_DIR } from './paths';

/** Core Nest packages that follow `NEST_VERSION`. */
const NEST_CORE = ['common', 'core', 'platform-express', 'platform-fastify', 'microservices', 'testing'].map(
  (n) => `@nestjs/${n}`,
);

/** First number in a version or range (`'12'` → 12, `'^0.3'` → 0, `'^6'` → 6). */
function major(range: string): number {
  const m = /\d+/.exec(range);
  if (!m) throw new Error(`no major version in ${JSON.stringify(range)}`);
  return Number(m[0]);
}

/**
 * The fixture's dependency versions for `NEST_VERSION` (default 12), `TYPEORM_VERSION` (default ^1) and
 * `MIKRO_VERSION` (default ^7) and `BULLMQ_VERSION` (default ^6.5.1). Integrations (`@nestjs/typeorm`,
 * `@mikro-orm/nestjs`) follow the major of the package they integrate; `@nestjs/bullmq` follows Nest.
 */
function fixtureVersions(name: string): string | undefined {
  const nest = process.env.NEST_VERSION ?? '12';
  const typeorm = process.env.TYPEORM_VERSION ?? '^1';
  const mikro = process.env.MIKRO_VERSION ?? '^7';
  const bullmq = process.env.BULLMQ_VERSION ?? '^6.5.1';
  if (NEST_CORE.includes(name)) return nest;
  if (name === '@nestjs/typeorm') return `^${major(nest)}`;
  if (name === '@nestjs/bullmq') return `^${major(nest)}`;
  if (name === 'bullmq') return bullmq;
  if (name === 'typeorm') return typeorm;
  if (name === '@mikro-orm/nestjs') return `^${major(mikro)}`;
  if (name.startsWith('@mikro-orm/')) return mikro;
  return undefined;
}

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/**
 * Builds and packs the library, then installs the fixture app from the tarball into
 * <os tmpdir>/oxth-nestjs-otel-e2e-<hash>/fixture (its own pnpm project outside the repo, so
 * there is exactly one @nestjs/core and the repo's node_modules can't mask a missing dependency)
 * and compiles it into esm/ and cjs/.
 */
export default function setup(): void {
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
    pkg.dependencies[name] = fixtureVersions(name) ?? pkg.dependencies[name];
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
