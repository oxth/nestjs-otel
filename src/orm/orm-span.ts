import { type Attributes, context, createContextKey, type Span, SpanKind } from '@opentelemetry/api';
import { getDefaultRedactor, serializeBody } from '../redact/redactor';
import { safely } from '../shared/safe';
import { getClassifyDefaults } from '../tracing/decorators';
import { handleResult, runInSpan } from '../tracing/wrap';
import { getDbSettings } from './settings';

export type OrmScope = 'leaf' | 'container';

export interface OrmCall {
  orm: 'typeorm' | 'mikro-orm';
  operation: string;
  entity?: string;
  collection?: string;
  system?: string;
  /** Lazily evaluated; only called when capture applies. */
  params?: () => unknown;
  /** Default `'leaf'`. */
  scope?: OrmScope;
}

const ORM_SCOPE = createContextKey('@oxth/nestjs-otel.orm-scope');

const LABELS = { typeorm: 'TypeORM', 'mikro-orm': 'MikroORM' } as const;

export function isInsideOrmLeaf(): boolean {
  const v = context.active().getValue(ORM_SCOPE) as { scope?: OrmScope } | undefined;
  return v?.scope === 'leaf';
}

function attachParams(span: Span, call: OrmCall): void {
  if (!call.params) return;
  safely(
    'attach orm params',
    () => {
      const { maxParamsBytes } = getDbSettings();
      const { body, truncated } = serializeBody(getDefaultRedactor().redact(call.params!()), maxParamsBytes);
      span.setAttribute('db.orm.params', body);
      if (truncated) span.setAttribute('db.orm.params.truncated', true);
    },
    undefined,
  );
}

export function runOrmSpan<T>(call: OrmCall, fn: () => T): T {
  if (isInsideOrmLeaf()) return fn();

  const name = `${LABELS[call.orm]} ${call.operation}${call.entity ? ' ' + call.entity : ''}`;
  const attributes = (): Attributes => {
    const a: Attributes = { 'db.orm.name': call.orm, 'db.operation.name': call.operation };
    if (call.entity !== undefined) a['db.orm.entity'] = call.entity;
    if (call.collection !== undefined) a['db.collection.name'] = call.collection;
    if (call.system !== undefined) a['db.system.name'] = call.system;
    return a;
  };
  return runInSpan(
    name,
    () => ({ kind: SpanKind.INTERNAL, attributes: attributes() }),
    getClassifyDefaults,
    (span) => {
      let failed = false;
      const onError = () => {
        failed = true;
        if (safely('db settings', () => getDbSettings().captureParams, 'never') !== 'never') attachParams(span, call);
      };
      let result: T;
      try {
        result = context.with(context.active().setValue(ORM_SCOPE, { scope: call.scope ?? 'leaf' }), fn);
      } catch (err) {
        onError();
        throw err;
      }
      return handleResult(result, {
        onError,
        onFinally: () => {
          if (!failed && safely('db settings', () => getDbSettings().captureParams, 'never') === 'always') {
            attachParams(span, call);
          }
        },
      });
    },
  );
}
