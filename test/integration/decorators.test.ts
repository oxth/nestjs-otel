import {
  type CanActivate,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  type INestApplication,
  Param,
  UseGuards,
} from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NoTrace, Span, SpanAttribute, Trace, TraceService } from '../../src/index';
import { NO_TRACE_META, TRACE_META } from '../../src/tracing/decorators';
import { setupInMemoryTracing } from './helpers/tracing';

const t = setupInMemoryTracing();

let guardCalls = 0;

@Injectable()
class AllowGuard implements CanActivate {
  canActivate(): boolean {
    guardCalls++;
    return true;
  }
}

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Injectable()
class UsersService {
  @Span()
  async find(@SpanAttribute('user.id') id: string, @SpanAttribute('user.extra') _extra?: object): Promise<string> {
    return `user-${id}`;
  }
}

@Controller('x')
class XController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get(':id')
  @HttpCode(202)
  @UseGuards(AllowGuard)
  @Span()
  handler(@Param('id') id: string): string {
    return id === '7' ? 'ok' : 'other';
  }

  @Span('custom.name', { attributes: { 'app.flag': true } })
  @Get('user/:id')
  user(@Param('id') id: string): Promise<string> {
    return this.users.find(id, {});
  }

  @Get('denied/:id')
  @UseGuards(DenyGuard)
  @Span()
  denied(@Param('id') id: string): string {
    return id;
  }
}

@Trace()
class Marked {
  @NoTrace()
  skip(): void {}

  @Trace()
  keep(): void {}
}

let app: INestApplication;
let traceService: TraceService;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [XController],
    providers: [UsersService, AllowGuard, DenyGuard, TraceService],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  traceService = app.get(TraceService);
});

afterAll(async () => {
  await app?.close();
  await t.shutdown();
});

describe('tracing decorators', () => {
  it('keeps routing, guards and HttpCode after wrapping', async () => {
    guardCalls = 0;
    await request(app.getHttpServer()).get('/x/7').expect(202, 'ok');
    expect(guardCalls).toBe(1);
    expect(t.spans().map((s) => s.name)).toContain('XController.handler');
    const span = t.spans().find((s) => s.name === 'XController.handler')!;
    expect(span.attributes).toMatchObject({ 'code.namespace': 'XController', 'code.function': 'handler' });
  });

  it('guards still block a wrapped handler', async () => {
    await request(app.getHttpServer()).get('/x/denied/1').expect(403);
    expect(t.spans()).toHaveLength(0);
  });

  it('@Span above route decorators uses custom name and attributes', async () => {
    await request(app.getHttpServer()).get('/x/user/5').expect(200, 'user-5');
    const outer = t.spans().find((s) => s.name === 'custom.name')!;
    expect(outer.attributes).toMatchObject({ 'app.flag': true, 'code.function': 'user' });
  });

  it('@SpanAttribute on a provider method', async () => {
    await request(app.getHttpServer()).get('/x/user/42').expect(200, 'user-42');
    const inner = t.spans().find((s) => s.name === 'UsersService.find')!;
    const outer = t.spans().find((s) => s.name === 'custom.name')!;
    expect(inner.attributes).toMatchObject({ 'user.id': '42', 'code.namespace': 'UsersService' });
    expect(inner.attributes['user.extra']).toBeUndefined();
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
  });

  it('TraceService.startActiveSpan ends span and records errors', async () => {
    const v = traceService.startActiveSpan(
      'svc.ok',
      (span) => {
        expect(traceService.getActiveSpan()).toBe(span);
        traceService.setAttributes({ 'k.v': 1 });
        return 3;
      },
      { attributes: { 'a.b': 'c' } },
    );
    expect(v).toBe(3);
    const ok = t.spans().find((s) => s.name === 'svc.ok')!;
    expect(ok.attributes).toMatchObject({ 'a.b': 'c', 'k.v': 1 });

    const e = new Error('svc failed');
    await expect(
      traceService.startActiveSpan('svc.fail', async () => {
        throw e;
      }),
    ).rejects.toBe(e);
    const fail = t.spans().find((s) => s.name === 'svc.fail')!;
    expect(fail.status.code).toBe(SpanStatusCode.ERROR);
    expect(fail.events.filter((ev) => ev.name === 'exception')).toHaveLength(1);
  });

  it('TraceService.recordException marks the active span', () => {
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('manual', (span) => {
      traceService.recordException(new Error('manual'));
      span.end();
    });
    const manual = t.spans().find((s) => s.name === 'manual')!;
    expect(manual.status.code).toBe(SpanStatusCode.ERROR);
    // no active span: no-op
    expect(() => traceService.recordException(new Error('none'))).not.toThrow();
    expect(traceService.getActiveSpan()).toBeUndefined();
  });

  it('@Trace / @NoTrace set metadata on classes and methods', () => {
    expect(Reflect.getMetadata(TRACE_META, Marked)).toBe(true);
    expect(Reflect.getMetadata(NO_TRACE_META, Marked.prototype.skip)).toBe(true);
    expect(Reflect.getMetadata(TRACE_META, Marked.prototype.keep)).toBe(true);
  });
});
