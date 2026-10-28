import { createRequire } from 'node:module';
import { join } from 'node:path';

export function isInstalled(pkg: string, fromDir?: string): boolean {
  try {
    createRequire(join(fromDir ?? process.cwd(), 'noop.js')).resolve(pkg);
    return true;
  } catch {
    return false;
  }
}
