import {
  Controller,
  Get,
  Inject,
  Injectable,
  type INestApplication,
  Logger,
  Module,
  NotFoundException,
} from '@nestjs/common';
import { SpanStatusCode } from '@opentelemetry/api';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OtelModule, type OtelModuleOptions, TraceService } from '../../src/index';
import { OTEL_OPTIONS, type ResolvedOtelOptions, resolveOptions } from '../../src/module/options';
import { getDbSettings, resolveDbSettings, setDbSettings } from '../../src/orm/settings';
import { getGlobalState } from '../../src/shared/global-state';
import { getClassifyDefaults, setClassifyDefaults } from '../../src/tracing/decorators';
import { setupInMemoryTracing } from './helpers/tracing';

const t = setupInMemoryTracing();

const WARNING =
  '@oxth/nestjs-otel: OtelModule loaded but register was not; only spans from decorators will be created. Add --import @oxth/nestjs-otel/register (see README).';

@Injectable()
class ConfigService {
  get(key: string): unknown {
    return key === 'treat4xx' ? true : undefined;
  }
}

@Module({ providers: [ConfigService], exports: [ConfigService] })
class ConfigModule {}

@Controller('items')
class ItemsController {
  @Get('missing')
  missing(): never {
    throw new NotFoundException('nope');
  }
}

@Module({ controllers: [ItemsController] })
class ItemsModule {}

@Injectable()
class UsesTrace {
  constructor(@Inject(TraceService) readonly traces: TraceService) {}
}

@Module({ providers: [UsesTrace] })
class ConsumerModule {}

let app: INestApplication | undefined;

async function boot(imports: unknown[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: imports as never[] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  setClassifyDefaults({ treat4xxAsError: false });
});

describe('resolveOptions', () => {
  it('applies defaults', () => {
    const o = resolveOptions();
    expect(o.autoInstrument).toEqual({
      controllers: true,
      providers: true,
      guards: false,
      interceptors: false,
      pipes: false,
      filters: false,
      include: [],
      exclude: [],
    });
    expect(o.errors).toEqual({ treat4xxAsError: false });
    expect(o.classify).toEqual({ treat4xxAsError: false });
    expect(o.capture).toMatchObject({ requestBody: true, responseBody: false, maxBodyBytes: 8192 });
    expect(o.capture.getUserId({ user: { id: 7 } })).toBe(7);
    expect(o.capture.getUserId(undefined)).toBeUndefined();
    expect(o.redactor.redact({ password: 'x' })).toEqual({ password: '[REDACTED]' });
  });

  it('keeps provided values', () => {
    const getUserId = () => 'u';
    const o = resolveOptions({
      autoInstrument: { guards: true, exclude: ['A'] },
      errors: { treat4xxAsError: true },
      capture: { maxBodyBytes: 10, getUserId },
      redact: { censor: '***' },
    });
    expect(o.autoInstrument).toMatchObject({ controllers: true, guards: true, exclude: ['A'] });
    expect(o.classify).toEqual({ treat4xxAsError: true });
    expect(o.capture).toMatchObject({ requestBody: true, maxBodyBytes: 10, getUserId });
    expect(o.redactor.redact({ password: 'x' })).toEqual({ password: '***' });
  });
});

describe('OtelModule', () => {
  it('forRootAsync resolves options from a factory', async () => {
    await boot([
      ItemsModule,
      OtelModule.forRootAsync({
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: async (config: ConfigService): Promise<OtelModuleOptions> => ({
          errors: { treat4xxAsError: config.get('treat4xx') as boolean },
        }),
      }),
    ]);
    expect(app!.get<ResolvedOtelOptions>(OTEL_OPTIONS).classify).toEqual({ treat4xxAsError: true });
    expect(getClassifyDefaults()).toEqual({ treat4xxAsError: true });
    await request(app!.getHttpServer()).get('/items/missing').expect(404);
    const span = t.spans().find((s) => s.name === 'ItemsController.missing')!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('forRoot treats 4xx as expected by default', async () => {
    await boot([ItemsModule, OtelModule.forRoot()]);
    await request(app!.getHttpServer()).get('/items/missing').expect(404);
    const span = t.spans().find((s) => s.name === 'ItemsController.missing')!;
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes['error.expected']).toBe(true);
  });

  it('warns once when register was not loaded', async () => {
    getGlobalState().warned.clear();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await boot([OtelModule.forRoot()]);
    await app!.close();
    await boot([OtelModule.forRoot()]);
    expect(warn.mock.calls.filter((c) => c[0] === WARNING)).toHaveLength(1);
  });

  it('does not warn when OTEL_SDK_DISABLED=true or the sdk is registered', async () => {
    getGlobalState().warned.clear();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.stubEnv('OTEL_SDK_DISABLED', ' TRUE ');
    try {
      await boot([OtelModule.forRoot()]);
    } finally {
      vi.unstubAllEnvs();
    }
    await app!.close();
    const state = getGlobalState();
    state.sdk = { shutdown: vi.fn(async () => {}), forceFlush: vi.fn(async () => {}) };
    try {
      await boot([OtelModule.forRoot()]);
    } finally {
      await app!.close();
      app = undefined;
      delete state.sdk;
    }
    expect(warn.mock.calls.filter((c) => c[0] === WARNING)).toHaveLength(0);
  });

  it('shuts the sdk down on application shutdown', async () => {
    const state = getGlobalState();
    const shutdown = vi.fn(async () => {});
    state.sdk = { shutdown, forceFlush: vi.fn(async () => {}) };
    try {
      await boot([OtelModule.forRoot()]);
      await app!.close();
      app = undefined;
    } finally {
      delete state.sdk;
    }
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('exports TraceService globally', async () => {
    await boot([ConsumerModule, OtelModule.forRoot()]);
    expect(app!.get(UsesTrace).traces).toBeInstanceOf(TraceService);
  });

  it('forRoot({ db }) sets global db settings', async () => {
    await boot([OtelModule.forRoot({ db: { captureParams: 'never' } })]);
    expect(getDbSettings().captureParams).toBe('never');
    setDbSettings(resolveDbSettings());
  });
});
