import {
  type DynamicModule,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { APP_INTERCEPTOR, ModulesContainer } from '@nestjs/core';
import { readBootstrapConfig } from '../bootstrap/config';
import { getSdkHandle } from '../bootstrap/sdk';
import { HttpOtelInterceptor } from '../http/http-otel.interceptor';
import { OtelLogger } from '../logs/otel-logger';
import { MetricService } from '../metrics/metric.service';
import { setDbSettings } from '../orm/settings';
import { setBullmqSettings } from '../queue/settings';
import { setDefaultRedactor } from '../redact/redactor';
import { getGlobalState } from '../shared/global-state';
import { safely } from '../shared/safe';
import { setClassifyDefaults } from '../tracing/decorators';
import { TraceService } from '../tracing/trace.service';
import { instrumentApplication } from './auto-instrument';
import {
  OTEL_INSTRUMENTED,
  OTEL_OPTIONS,
  type OtelModuleAsyncOptions,
  type OtelModuleOptions,
  type ResolvedOtelOptions,
  resolveOptions,
} from './options';

const REGISTER_MISSING_WARNING =
  '@oxth/nestjs-otel: OtelModule loaded but register was not; only spans from decorators will be created. Add --import @oxth/nestjs-otel/register (see README).';

// A factory provider: it runs while Nest instantiates the application, before
// `app.init()` binds routes, so prototype patches reach every route handler.
const instrumentedProvider: Provider = {
  provide: OTEL_INSTRUMENTED,
  inject: [ModulesContainer, OTEL_OPTIONS],
  useFactory: (container: ModulesContainer, opts: ResolvedOtelOptions) => {
    safely('set classify defaults', () => setClassifyDefaults(opts.classify), undefined);
    safely('set default redactor', () => setDefaultRedactor(opts.redactor), undefined);
    safely('set db settings', () => setDbSettings(opts.db), undefined);
    safely('set bullmq settings', () => setBullmqSettings(opts.bullmq), undefined);
    return safely('instrument application', () => instrumentApplication(container, opts), { wrapped: [] });
  },
};

const sharedProviders: Provider[] = [
  instrumentedProvider,
  TraceService,
  MetricService,
  OtelLogger,
  { provide: APP_INTERCEPTOR, useClass: HttpOtelInterceptor },
];
const sharedExports = [TraceService, MetricService, OtelLogger];

@Module({})
export class OtelModule implements OnModuleInit, OnApplicationShutdown {
  static forRoot(o?: OtelModuleOptions): DynamicModule {
    return {
      module: OtelModule,
      global: true,
      providers: [{ provide: OTEL_OPTIONS, useValue: resolveOptions(o) }, ...sharedProviders],
      exports: sharedExports,
    };
  }

  static forRootAsync(o: OtelModuleAsyncOptions): DynamicModule {
    return {
      module: OtelModule,
      global: true,
      imports: o.imports ?? [],
      providers: [
        {
          provide: OTEL_OPTIONS,
          inject: o.inject ?? [],
          useFactory: async (...args: unknown[]) => resolveOptions(await o.useFactory(...args)),
        },
        ...sharedProviders,
      ],
      exports: sharedExports,
    };
  }

  onModuleInit(): void {
    safely(
      'register check',
      () => {
        if (getSdkHandle() || readBootstrapConfig(process.env).disabled) return;
        const { warned } = getGlobalState();
        if (warned.has(REGISTER_MISSING_WARNING)) return;
        warned.add(REGISTER_MISSING_WARNING);
        new Logger('OtelModule').warn(REGISTER_MISSING_WARNING);
      },
      undefined,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    // The handle's shutdown never rejects; `safely` covers a throwing getter.
    await safely('sdk shutdown', () => getSdkHandle()?.shutdown(), undefined);
  }
}
