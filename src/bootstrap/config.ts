export type InstrumentationName = 'http' | 'express' | 'fastify' | 'pino' | 'runtime-node' | 'pg' | 'mysql2' | 'mongodb' | 'typeorm' | 'mikro-orm' | 'bullmq';

export interface BootstrapConfig {
  /** `OTEL_SDK_DISABLED === 'true'` */
  disabled: boolean;
  /** `OTEL_NODE_ENABLED_INSTRUMENTATIONS`; `null` means all. */
  enabled: Set<string> | null;
  /** `OTEL_NODE_DISABLED_INSTRUMENTATIONS` */
  disabledInstrumentations: Set<string>;
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function readBootstrapConfig(env: NodeJS.ProcessEnv): BootstrapConfig {
  const enabled = parseList(env.OTEL_NODE_ENABLED_INSTRUMENTATIONS);
  return {
    disabled: env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true',
    enabled: enabled.length > 0 ? new Set(enabled) : null,
    disabledInstrumentations: new Set(parseList(env.OTEL_NODE_DISABLED_INSTRUMENTATIONS)),
  };
}
