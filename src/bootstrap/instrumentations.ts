import { IncomingMessage } from 'node:http';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { MySQL2Instrumentation } from '@opentelemetry/instrumentation-mysql2';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { MikroOrmInstrumentation } from '../orm/mikro-orm';
import { TypeormInstrumentation } from '../orm/typeorm';
import { DEFAULT_QUERY_PARAMS } from '../redact/defaults';
import { maskSqlLiterals } from '../redact/sql-mask';
import { safely } from '../shared/safe';
import { ROOT_SPAN } from '../shared/symbols';
import type { BootstrapConfig, InstrumentationName } from './config';
import { isInstalled } from './detect';

export interface InstrumentationEntry {
  name: InstrumentationName;
  /** Package that must be installed for the entry to apply; `null` = always available. */
  pkg: string | null;
  create(): Instrumentation;
}

export const INSTRUMENTATIONS: InstrumentationEntry[] = [
  {
    name: 'http',
    pkg: null,
    create: () =>
      new HttpInstrumentation({
        redactedQueryParams: [...DEFAULT_QUERY_PARAMS],
        redactedQueryParamsServer: [...DEFAULT_QUERY_PARAMS],
        requestHook(span, req) {
          safely(
            'http requestHook',
            () => {
              if (req instanceof IncomingMessage) {
                (req as unknown as Record<symbol, unknown>)[ROOT_SPAN] = span;
              }
            },
            undefined,
          );
        },
      }),
  },
  { name: 'express', pkg: 'express', create: () => new ExpressInstrumentation() },
  {
    name: 'fastify',
    pkg: 'fastify',
    create: () => new FastifyOtelInstrumentation({ registerOnInitialization: true }),
  },
  { name: 'pino', pkg: 'pino', create: () => new PinoInstrumentation() },
  { name: 'runtime-node', pkg: null, create: () => new RuntimeNodeInstrumentation() },
  {
    name: 'pg',
    pkg: 'pg',
    create: () =>
      new PgInstrumentation({
        enhancedDatabaseReporting: false,
        requestHook(span, info) {
          safely(
            'pg requestHook',
            () => {
              span.setAttribute('db.query.text', maskSqlLiterals(info.query.text, { doubleQuotedStrings: false }));
            },
            undefined,
          );
        },
      }),
  },
  {
    name: 'mysql2',
    pkg: 'mysql2',
    create: () =>
      new MySQL2Instrumentation({
        maskStatement: true,
        // Same masking as the ORM layer (backtick identifiers, comments, multi-line strings); `?` if it fails.
        maskStatementHook: (query) => safely('mysql2 maskStatementHook', () => maskSqlLiterals(query), '?'),
      }),
  },
  { name: 'mongodb', pkg: 'mongodb', create: () => new MongoDBInstrumentation({ enhancedDatabaseReporting: false }) },
  { name: 'typeorm', pkg: 'typeorm', create: () => new TypeormInstrumentation() },
  { name: 'mikro-orm', pkg: '@mikro-orm/core', create: () => new MikroOrmInstrumentation() },
];

export function buildInstrumentations(
  cfg: BootstrapConfig,
  installed: (pkg: string) => boolean = (pkg) => isInstalled(pkg),
): Instrumentation[] {
  const result: Instrumentation[] = [];
  for (const entry of INSTRUMENTATIONS) {
    if (entry.pkg !== null && !installed(entry.pkg)) continue;
    if (cfg.enabled !== null && !cfg.enabled.has(entry.name)) continue;
    if (cfg.disabledInstrumentations.has(entry.name)) continue;
    const instrumentation = safely<Instrumentation | undefined>(`create ${entry.name} instrumentation`, entry.create, undefined);
    if (instrumentation) result.push(instrumentation);
  }
  return result;
}
