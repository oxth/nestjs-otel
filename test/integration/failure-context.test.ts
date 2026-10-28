import {
  Body,
  type CanActivate,
  Controller,
  Get,
  HttpException,
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { NoCaptureBody, OtelModule, type OtelModuleOptions } from '../../src/index';
import { setClassifyDefaults } from '../../src/tracing/decorators';
import { setupInMemoryTracing } from './helpers/tracing';

const t = setupInMemoryTracing();

class ExplodingGuard implements CanActivate {
  canActivate(): boolean {
    throw new Error('guard broke');
  }
}

@Controller('users')
class UsersController {
  @Post('guarded')
  @UseGuards(ExplodingGuard)
  guarded(): never {
    throw new Error('never');
  }

  @Post('guarded-secret')
  @NoCaptureBody()
  @UseGuards(ExplodingGuard)
  guardedSecret(): never {
    throw new Error('never');
  }

  @Get(':id')
  findOne(@Param('id') id: string): { id: string } {
    if (id === '404') throw new NotFoundException(`user ${id} not found`);
    if (id === '500') throw new Error('db exploded');
    return { id };
  }

  @Post()
  create(@Body() body: { name: string }): { name: string } {
    if (body?.name === 'fail') throw new Error('create failed');
    return { name: body.name };
  }

  @Post('secret')
  @NoCaptureBody()
  secret(@Body() _body: unknown): never {
    throw new Error('secret failed');
  }

  @Post('upload')
  upload(): never {
    throw new Error('upload failed');
  }

  @Get('leaky/:id')
  leaky(): never {
    throw new HttpException({ message: 'leaky failed', token: 'abc123' }, 503);
  }
}

@Module({ controllers: [UsersController] })
class UsersModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Root span for the request, like the HTTP instrumentation would create; plus an auth'd user.
    consumer
      .apply((req: { user?: unknown }, res: { on(e: string, f: () => void): void }, next: () => void) => {
        req.user = { id: 7 };
        trace.getTracer('test').startActiveSpan('root', { attributes: { 'test.root': true } }, (span) => {
          res.on('finish', () => span.end());
          next();
        });
      })
      .forRoutes('*path');
  }
}

let app: INestApplication | undefined;

async function boot(opts?: OtelModuleOptions): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [UsersModule, OtelModule.forRoot(opts)] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  t.reset();
  return app;
}

const rootSpan = () => t.spans().find((s) => s.attributes['test.root'])!;

afterEach(async () => {
  await app?.close();
  app = undefined;
  setClassifyDefaults({ treat4xxAsError: false });
});

describe('HTTP failure context', () => {
  it('names the root span by route template', async () => {
    await boot();
    await request(app!.getHttpServer()).get('/users/1').expect(200);
    const root = rootSpan();
    expect(root.name).toBe('GET /users/:id');
    expect(root.attributes['http.route']).toBe('/users/:id');
  });

  it('5xx: error status, redacted body, user id on root span', async () => {
    await boot();
    await request(app!.getHttpServer()).post('/users').send({ name: 'fail', password: 'p' }).expect(500);
    const root = rootSpan();
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.parse(root.attributes['http.request.body'] as string)).toEqual({ name: 'fail', password: '[REDACTED]' });
    expect(root.attributes['http.request.body.truncated']).toBeUndefined();
    expect(root.attributes['user.id']).toBe('7');
    // The controller span got the exception event; the root only the status.
    const ctrl = t.spans().find((s) => s.name === 'UsersController.create')!;
    expect(ctrl.events.filter((e) => e.name === 'exception')).toHaveLength(1);
    expect(root.events.filter((e) => e.name === 'exception')).toHaveLength(0);
  });

  it('success: no body attribute', async () => {
    await boot();
    await request(app!.getHttpServer()).post('/users').send({ name: 'ok', password: 'p' }).expect(201);
    const root = rootSpan();
    expect(root.attributes['http.request.body']).toBeUndefined();
    expect(root.attributes['user.id']).toBeUndefined();
    expect(root.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('4xx: no body, status unset, exception.handled event', async () => {
    await boot();
    await request(app!.getHttpServer()).get('/users/404').expect(404);
    const root = rootSpan();
    expect(root.status.code).toBe(SpanStatusCode.UNSET);
    expect(root.attributes['http.request.body']).toBeUndefined();
    expect(root.attributes['user.id']).toBeUndefined();
    const handled = root.events.find((e) => e.name === 'exception.handled')!;
    expect(handled.attributes!['http.response.status_code']).toBe(404);
  });

  it('treat4xxAsError: 404 marked error with body', async () => {
    await boot({ errors: { treat4xxAsError: true } });
    await request(app!.getHttpServer())
      .get('/users/404')
      .set('content-type', 'application/json')
      .send({ q: 1 })
      .expect(404);
    const root = rootSpan();
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.attributes['http.request.body']).toBe('{"q":1}');
    expect(root.attributes['user.id']).toBe('7');
  });

  it('@NoCaptureBody suppresses body', async () => {
    await boot();
    await request(app!.getHttpServer()).post('/users/secret').send({ name: 'x' }).expect(500);
    const root = rootSpan();
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.attributes['http.request.body']).toBeUndefined();
    expect(root.attributes['http.request.body.size']).toBeUndefined();
    expect(root.attributes['user.id']).toBe('7');
  });

  it('guard error: body and user id on root span, @NoCaptureBody honoured', async () => {
    await boot();
    await request(app!.getHttpServer()).post('/users/guarded').send({ name: 'g' }).expect(500);
    let root = rootSpan();
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.attributes['http.request.body']).toBe('{"name":"g"}');
    expect(root.attributes['user.id']).toBe('7');

    t.reset();
    await request(app!.getHttpServer()).post('/users/guarded-secret').send({ name: 'g' }).expect(500);
    root = rootSpan();
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.attributes['http.request.body']).toBeUndefined();
  });

  it('capture.requestBody:false suppresses body', async () => {
    await boot({ capture: { requestBody: false } });
    await request(app!.getHttpServer()).post('/users').send({ name: 'fail' }).expect(500);
    expect(rootSpan().attributes['http.request.body']).toBeUndefined();
  });

  it('multipart: size and content-type only', async () => {
    await boot();
    const payload = '--x\r\nContent-Disposition: form-data; name="f"\r\n\r\nhello\r\n--x--\r\n';
    await request(app!.getHttpServer())
      .post('/users/upload')
      .set('content-type', 'multipart/form-data; boundary=x')
      .send(payload)
      .expect(500);
    const root = rootSpan();
    expect(root.attributes['http.request.body']).toBeUndefined();
    expect(root.attributes['http.request.body.size']).toBe(Buffer.byteLength(payload));
    expect(root.attributes['http.request.header.content-type']).toBe('multipart/form-data; boundary=x');
  });

  it('body over maxBodyBytes is truncated and flagged', async () => {
    await boot({ capture: { maxBodyBytes: 10 } });
    await request(app!.getHttpServer()).post('/users').send({ name: 'fail', extra: 'x'.repeat(100) }).expect(500);
    const root = rootSpan();
    expect(root.attributes['http.request.body']).toBe('{"name":"f');
    expect(root.attributes['http.request.body.truncated']).toBe(true);
  });

  it('custom getUserId', async () => {
    await boot({ capture: { getUserId: () => 'u-1' } });
    await request(app!.getHttpServer()).get('/users/500').expect(500);
    expect(rootSpan().attributes['user.id']).toBe('u-1');
  });

  it('a throwing getUserId does not drop the request body', async () => {
    await boot({
      capture: {
        getUserId: () => {
          throw new Error('no user');
        },
      },
    });
    await request(app!.getHttpServer()).post('/users').send({ name: 'fail', password: 'p' }).expect(500);
    const root = rootSpan();
    expect(root.attributes['user.id']).toBeUndefined();
    expect(JSON.parse(root.attributes['http.request.body'] as string)).toEqual({ name: 'fail', password: '[REDACTED]' });
  });

  it('responseBody option captures redacted 5xx response payload', async () => {
    await boot({ capture: { responseBody: true } });
    await request(app!.getHttpServer()).get('/users/leaky/1').expect(503);
    const root = rootSpan();
    expect(JSON.parse(root.attributes['http.response.body'] as string)).toEqual({
      message: 'leaky failed',
      token: '[REDACTED]',
    });
  });

  it('responseBody is off by default and never captured for 2xx/4xx', async () => {
    await boot();
    await request(app!.getHttpServer()).get('/users/leaky/1').expect(503);
    expect(rootSpan().attributes['http.response.body']).toBeUndefined();

    app && (await app.close());
    await boot({ capture: { responseBody: true } });
    await request(app!.getHttpServer()).get('/users/1').expect(200);
    expect(rootSpan().attributes['http.response.body']).toBeUndefined();
    t.reset();
    await request(app!.getHttpServer()).get('/users/404').expect(404);
    expect(rootSpan().attributes['http.response.body']).toBeUndefined();
  });
});
