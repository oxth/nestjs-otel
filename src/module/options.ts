import type { ClassifyOptions } from '../errors/classify';
import { type BullmqOptions, type BullmqSettings, resolveBullmqSettings } from '../queue/settings';
import { resolveDbSettings, type DbOptions, type DbSettings } from '../orm/settings';
import { createRedactor, type RedactOptions, type Redactor } from '../redact/redactor';
import { DEFAULT_MAX_BODY_BYTES } from '../shared/constants';

export interface OtelModuleOptions {
  autoInstrument?: {
    controllers?: boolean;
    providers?: boolean;
    guards?: boolean;
    interceptors?: boolean;
    pipes?: boolean;
    /** Exception filters (classes decorated with `@Catch()`). Default `false`. */
    filters?: boolean;
    /** Class names always wrapped, even in dynamic modules. */
    include?: (string | RegExp)[];
    /** Class names never wrapped. Wins over `include` and `@Trace()`. */
    exclude?: (string | RegExp)[];
    /**
     * Client spans for `ClientProxy.send`/`emit` and W3C context propagation over the TCP and
     * Redis transports. Default `true`. Handler spans follow `controllers`.
     */
    microservices?: boolean;
  };
  errors?: { treat4xxAsError?: boolean };
  capture?: {
    requestBody?: boolean;
    responseBody?: boolean;
    maxBodyBytes?: number;
    getUserId?: (req: any) => string | number | undefined;
  };
  redact?: RedactOptions;
  db?: DbOptions;
  bullmq?: BullmqOptions;
}

export interface ResolvedOtelOptions {
  autoInstrument: {
    controllers: boolean;
    providers: boolean;
    guards: boolean;
    interceptors: boolean;
    pipes: boolean;
    filters: boolean;
    include: (string | RegExp)[];
    exclude: (string | RegExp)[];
    microservices: boolean;
  };
  errors: { treat4xxAsError: boolean };
  capture: {
    requestBody: boolean;
    responseBody: boolean;
    maxBodyBytes: number;
    getUserId: (req: any) => string | number | undefined;
  };
  redact: RedactOptions;
  redactor: Redactor;
  db: DbSettings;
  bullmq: BullmqSettings;
  classify: ClassifyOptions;
}

export interface OtelModuleAsyncOptions {
  imports?: any[];
  inject?: any[];
  useFactory: (...a: any[]) => OtelModuleOptions | Promise<OtelModuleOptions>;
}

export const OTEL_OPTIONS = Symbol.for('@oxth/nestjs-otel.options');
/** Resolves to the `instrumentApplication` report once providers have been patched. */
export const OTEL_INSTRUMENTED = Symbol.for('@oxth/nestjs-otel.instrumented');

const defaultGetUserId = (req: any): string | number | undefined => req?.user?.id;

export function resolveOptions(o: OtelModuleOptions = {}): ResolvedOtelOptions {
  const a = o.autoInstrument ?? {};
  const c = o.capture ?? {};
  const treat4xxAsError = o.errors?.treat4xxAsError ?? false;
  const redact = o.redact ?? {};
  return {
    autoInstrument: {
      controllers: a.controllers ?? true,
      providers: a.providers ?? true,
      guards: a.guards ?? false,
      interceptors: a.interceptors ?? false,
      pipes: a.pipes ?? false,
      filters: a.filters ?? false,
      include: a.include ?? [],
      exclude: a.exclude ?? [],
      microservices: a.microservices ?? true,
    },
    errors: { treat4xxAsError },
    capture: {
      requestBody: c.requestBody ?? true,
      responseBody: c.responseBody ?? false,
      maxBodyBytes: c.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      getUserId: c.getUserId ?? defaultGetUserId,
    },
    redact,
    redactor: createRedactor(redact),
    db: resolveDbSettings(o.db),
    bullmq: resolveBullmqSettings(o.bullmq),
    classify: { treat4xxAsError },
  };
}
