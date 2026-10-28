import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Packages a Nest app usually reaches only through its platform adapter. With pnpm's isolated
 * layout `express`/`fastify` are not resolvable from the app root, only from the adapter.
 */
export const ADAPTER_PACKAGES: Readonly<Record<string, string>> = {
  express: '@nestjs/platform-express',
  fastify: '@nestjs/platform-fastify',
};

/** Where the app's dependencies are looked up: the working directory and the entry script's directory. */
export function defaultBaseDirs(): string[] {
  const dirs = [process.cwd()];
  const entry = process.argv[1];
  if (entry) dirs.push(dirname(entry));
  return dirs;
}

function resolveFrom(fromFile: string, pkg: string): string | undefined {
  try {
    return createRequire(fromFile).resolve(pkg);
  } catch {
    return undefined;
  }
}

/**
 * Whether `pkg` can be loaded by the app: resolvable from one of `fromDirs`, or from the Nest
 * adapter package that depends on it (see {@link ADAPTER_PACKAGES}).
 */
export function isInstalled(
  pkg: string,
  fromDirs: string[] = defaultBaseDirs(),
  adapters: Readonly<Record<string, string>> = ADAPTER_PACKAGES,
): boolean {
  const adapter = adapters[pkg];
  for (const dir of fromDirs) {
    const from = join(dir, 'noop.js');
    if (resolveFrom(from, pkg) !== undefined) return true;
    if (adapter === undefined) continue;
    const adapterEntry = resolveFrom(from, adapter);
    if (adapterEntry !== undefined && resolveFrom(adapterEntry, pkg) !== undefined) return true;
  }
  return false;
}
