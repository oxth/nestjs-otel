import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attributes } from '@opentelemetry/api';

interface PackageInfo {
  name?: string;
  version?: string;
}

function readPackageJson(cwd: string): PackageInfo {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    if (pkg === null || typeof pkg !== 'object') return {};
    const { name, version } = pkg as Record<string, unknown>;
    return {
      name: typeof name === 'string' && name ? name : undefined,
      version: typeof version === 'string' && version ? version : undefined,
    };
  } catch {
    return {};
  }
}

function resourceAttributeKeys(value: string | undefined): Set<string> {
  const keys = new Set<string>();
  for (const pair of (value ?? '').split(',')) {
    const idx = pair.indexOf('=');
    if (idx > 0) keys.add(pair.slice(0, idx).trim());
  }
  return keys;
}

export function buildResourceAttributes(env: NodeJS.ProcessEnv, cwd: string): Attributes {
  const attrs: Attributes = {};
  const fromEnv = resourceAttributeKeys(env.OTEL_RESOURCE_ATTRIBUTES);
  const pkg = readPackageJson(cwd);

  const serviceName = env.OTEL_SERVICE_NAME?.trim() || (fromEnv.has('service.name') ? undefined : pkg.name);
  if (serviceName) attrs['service.name'] = serviceName;
  if (pkg.version && !fromEnv.has('service.version')) attrs['service.version'] = pkg.version;
  if (env.NODE_ENV && !fromEnv.has('deployment.environment.name')) {
    attrs['deployment.environment.name'] = env.NODE_ENV;
  }
  return attrs;
}
