import {
  type ArgumentsHost,
  type CanActivate,
  Catch,
  Controller,
  type ExceptionFilter,
  type DynamicModule,
  type ExecutionContext,
  Get,
  Inject,
  Injectable,
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnModuleInit,
  Param,
  type PipeTransform,
  UseFilters,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { NoTrace, OtelModule, type OtelModuleOptions, Span, SpanAttribute, Trace } from '../../src/index';
import { OTEL_INSTRUMENTED } from '../../src/module/options';
import { setupInMemoryTracing } from './helpers/tracing';

const t = setupInMemoryTracing();

// ---------- static UsersModule ----------
@Injectable()
class UsersService {
  find(@SpanAttribute('user.id') id: string): { id: string } {
    return { id };
  }
}

@Controller('users')
class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get(':id')
  get(@Param('id') id: string): { id: string } {
    return this.users.find(id);
  }
}

@Module({ controllers: [UsersController], providers: [UsersService] })
class UsersModule {}

// ---------- dynamic LibModule ----------
@Injectable()
class LibService {
  call(): string {
    return 'lib';
  }
}

@Trace()
@Injectable()
class TracedLibService {
  call(): string {
    return 'traced';
  }
}

@Injectable()
class IncludedLibService {
  call(): string {
    return 'included';
  }
}

@Module({})
class LibModule {
  static forRoot(): DynamicModule {
    return {
      module: LibModule,
      providers: [LibService, TracedLibService, IncludedLibService],
      exports: [LibService],
    };
  }
}

// ---------- exclusions ----------
@Injectable()
class ExcludedService {
  run(): void {}
}

@NoTrace()
@Injectable()
class NoTraceClassService {
  run(): void {}
}

@Injectable()
class PartlyTracedService {
  run(): void {}

  @NoTrace()
  quiet(): void {}
}

// ---------- hooks, getters, factories ----------
@Injectable()
class HooksService implements OnModuleInit {
  onModuleInit(): void {}
  onApplicationBootstrap(): void {}
  onModuleDestroy(): void {}
  beforeApplicationShutdown(): void {}
  onApplicationShutdown(): void {}

  get value(): number {
    return 1;
  }

  set value(_v: number) {}

  work(): void {}
}

class FactoryMade {
  make(): void {}
}

class ValueMade {
  make(): void {}
}

// ---------- inheritance ----------
class Base {
  find(): string {
    return 'base';
  }
}

@Injectable()
class Child extends Base {
  other(): string {
    return this.find();
  }
}

// ---------- already wrapped ----------
@Injectable()
class DecoratedService {
  @Span('custom.span')
  run(): void {}
}

// ---------- guards / pipes / interceptors ----------
@Injectable()
class ExplodingGuard implements CanActivate {
  canActivate(): boolean {
    throw new Error('guard broke');
  }
}

@Injectable()
class AllowGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    return true;
  }
}

@Injectable()
class UpperPipe implements PipeTransform {
  transform(v: unknown): unknown {
    return typeof v === 'string' ? v.toUpperCase() : v;
  }
}

@Catch()
class TeapotFilter implements ExceptionFilter {
  catch(_err: unknown, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<{ status(c: number): { send(b: string): void } }>().status(418).send('teapot');
  }
}

@Controller('guarded')
class GuardedController {
  @Get('filtered')
  @UseFilters(TeapotFilter)
  filtered(): never {
    throw new Error('filtered');
  }

  @Get()
  @UseGuards(ExplodingGuard)
  get(): string {
    return 'never';
  }

  @Get('ok/:v')
  @UseGuards(AllowGuard)
  @UsePipes(UpperPipe)
  ok(@Param('v') v: string): string {
    return v;
  }
}

@Module({
  controllers: [GuardedController],
  providers: [
    ExcludedService,
    NoTraceClassService,
    PartlyTracedService,
    HooksService,
    Child,
    DecoratedService,
    { provide: 'FACTORY', useFactory: () => new FactoryMade() },
    { provide: 'VALUE', useValue: new ValueMade() },
    { provide: 'CLASS', useClass: FactoryMade },
  ],
})
class MiscModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Root span for the request, like the HTTP instrumentation would create.
    consumer
      .apply((_req: unknown, res: { on(e: string, f: () => void): void }, next: () => void) => {
        // Marked, because the HTTP interceptor renames it by route.
        trace.getTracer('test').startActiveSpan('root', { attributes: { 'test.root': true } }, (span) => {
          res.on('finish', () => span.end());
          next();
        });
      })
      .forRoutes('*path');
  }
}

let app: INestApplication | undefined;

async function boot(opts?: OtelModuleOptions, otelFirst = false): Promise<{ wrapped: string[] }> {
  const rest = [UsersModule, LibModule.forRoot(), MiscModule];
  // OtelModule imported last by default: modules instantiated before it must still be patched.
  const imports = otelFirst ? [OtelModule.forRoot(opts), ...rest] : [...rest, OtelModule.forRoot(opts)];
  const moduleRef = await Test.createTestingModule({ imports }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  t.reset();
  return app.get(OTEL_INSTRUMENTED);
}

// Every test boots a fresh app over the same classes; restore the original prototypes so
// each test starts from unwrapped methods.
const classes: Function[] = [
  UsersService,
  UsersController,
  LibService,
  TracedLibService,
  IncludedLibService,
  ExcludedService,
  NoTraceClassService,
  PartlyTracedService,
  HooksService,
  FactoryMade,
  ValueMade,
  Base,
  Child,
  DecoratedService,
  ExplodingGuard,
  AllowGuard,
  UpperPipe,
  TeapotFilter,
  GuardedController,
];
/** Span name, with the (route-renamed) test root span reported as `root`. */
const label = (s: { name: string; attributes: Record<string, unknown> }) => (s.attributes['test.root'] ? 'root' : s.name);
const labels = () => t.spans().map(label);
const names = () => labels().filter((n) => n !== 'root');

const pristine = new Map(classes.map((c) => [c, Object.getOwnPropertyDescriptors(c.prototype)]));

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const [cls, descriptors] of pristine) {
    for (const key of Object.getOwnPropertyNames(cls.prototype)) {
      if (!(key in descriptors)) delete (cls.prototype as Record<string, unknown>)[key];
    }
    Object.defineProperties(cls.prototype, descriptors);
  }
});

describe('instrumentApplication', () => {
  it('wraps controllers and static-module providers', async () => {
    await boot();
    await request(app!.getHttpServer()).get('/users/1').expect(200);
    const spans = t.spans().filter((s) => label(s) !== 'root');
    expect(names()).toEqual(['UsersService.find', 'UsersController.get']);
    const [svc, ctrl] = spans;
    expect(svc!.parentSpanContext?.spanId).toBe(ctrl!.spanContext().spanId);
    expect(svc!.attributes).toMatchObject({ 'code.namespace': 'UsersService', 'code.function': 'find', 'user.id': '1' });
    expect(ctrl!.attributes).toMatchObject({ 'code.namespace': 'UsersController', 'code.function': 'get' });
  });

  it('patches controllers when OtelModule is imported first, too', async () => {
    await boot(undefined, true);
    await request(app!.getHttpServer()).get('/users/1').expect(200);
    expect(names()).toContain('UsersController.get');
  });

  it('skips dynamic-module providers unless @Trace or include', async () => {
    const report = await boot({ autoInstrument: { include: ['IncludedLibService'] } });
    expect(report.wrapped).not.toContain('LibService.call');
    expect(report.wrapped).toContain('TracedLibService.call');
    expect(report.wrapped).toContain('IncludedLibService.call');
  });

  it('skips Nest internals and the module classes', async () => {
    const report = await boot();
    expect(report.wrapped.filter((n) => /^(ModuleRef|Reflector|HttpAdapterHost|TraceService|MiscModule)\./.test(n))).toEqual(
      [],
    );
  });

  it('honours exclude, @NoTrace class and method', async () => {
    const report = await boot({ autoInstrument: { exclude: [/^Excl/] } });
    expect(report.wrapped).not.toContain('ExcludedService.run');
    expect(report.wrapped).not.toContain('NoTraceClassService.run');
    expect(report.wrapped).toContain('PartlyTracedService.run');
    expect(report.wrapped).not.toContain('PartlyTracedService.quiet');
  });

  it('exclude wins over @Trace and include', async () => {
    const report = await boot({ autoInstrument: { include: ['TracedLibService'], exclude: ['TracedLibService'] } });
    expect(report.wrapped).not.toContain('TracedLibService.call');
  });

  it('does not wrap lifecycle hooks, getters, or factory providers', async () => {
    const report = await boot();
    const hooks = report.wrapped.filter((n) => n.startsWith('HooksService.'));
    expect(hooks).toEqual(['HooksService.work']);
    expect(Object.getOwnPropertyDescriptor(HooksService.prototype, 'value')!.get).toBeTypeOf('function');
    // useClass providers are classes; factory and value providers are not.
    expect(report.wrapped).toContain('FactoryMade.make');
    expect(report.wrapped).not.toContain('ValueMade.make');
  });

  it('does not wrap factory-provided classes', async () => {
    @Module({ providers: [{ provide: 'F', useFactory: () => new ValueMade() }] })
    class OnlyFactory {}
    const moduleRef = await Test.createTestingModule({ imports: [OnlyFactory, OtelModule.forRoot()] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    expect(app.get<{ wrapped: string[] }>(OTEL_INSTRUMENTED).wrapped).not.toContain('ValueMade.make');
  });

  it('wraps inherited methods once', async () => {
    const report = await boot();
    expect(report.wrapped.filter((n) => n.endsWith('.find') && !n.startsWith('Users'))).toEqual(['Child.find']);
    expect(Base.prototype.find).toBe(pristine.get(Base)!.find!.value);
    app!.get(Child).find();
    expect(labels()).toEqual(['Child.find']);
  });

  it('skips methods that already have @Span', async () => {
    const report = await boot();
    expect(report.wrapped).not.toContain('DecoratedService.run');
    app!.get(DecoratedService).run();
    expect(labels()).toEqual(['custom.span']);
  });

  it('does not wrap guards/pipes/interceptors by default but records guard errors on root span', async () => {
    await boot();
    await request(app!.getHttpServer()).get('/guarded').expect(500);
    const root = t.spans().find((s) => label(s) === 'root')!;
    expect(root.events.find((e) => e.name === 'exception')!.attributes!['exception.message']).toBe('guard broke');
    expect(labels()).not.toContain('ExplodingGuard.canActivate');

    t.reset();
    await request(app!.getHttpServer()).get('/guarded/ok/a').expect(200, 'A');
    expect(labels()).toEqual(['GuardedController.ok', 'root']);
  });

  it('wraps guards and pipes when enabled', async () => {
    await boot({ autoInstrument: { guards: true, pipes: true } });
    await request(app!.getHttpServer()).get('/guarded/ok/a').expect(200, 'A');
    expect(labels()).toEqual([
      'AllowGuard.canActivate',
      'UpperPipe.transform',
      'GuardedController.ok',
      'root',
    ]);

    t.reset();
    await request(app!.getHttpServer()).get('/guarded').expect(500);
    const names = labels();
    expect(names).toEqual(['ExplodingGuard.canActivate', 'root']);
    const root = t.spans().find((s) => label(s) === 'root')!;
    expect(root.status.code).toBe(2);
  });

  it('does not wrap exception filters unless filters:true', async () => {
    const report = await boot();
    expect(report.wrapped).not.toContain('TeapotFilter.catch');
    await request(app!.getHttpServer()).get('/guarded/filtered').expect(418, 'teapot');
    expect(names()).toEqual(['GuardedController.filtered']);

    await app!.close();
    const enabled = await boot({ autoInstrument: { filters: true } });
    expect(enabled.wrapped).toContain('TeapotFilter.catch');
    await request(app!.getHttpServer()).get('/guarded/filtered').expect(418, 'teapot');
    expect(names()).toEqual(['GuardedController.filtered', 'TeapotFilter.catch']);
  });

  it('respects controllers:false / providers:false', async () => {
    const report = await boot({ autoInstrument: { controllers: false, providers: false } });
    expect(report.wrapped.filter((n) => !n.startsWith('TracedLibService.'))).toEqual([]);
    await request(app!.getHttpServer()).get('/users/1').expect(200);
    expect(names()).toEqual([]);
  });

  it('controllers:false keeps provider spans', async () => {
    await boot({ autoInstrument: { controllers: false } });
    await request(app!.getHttpServer()).get('/users/1').expect(200);
    expect(names()).toEqual(['UsersService.find']);
  });
});
