import { Injectable } from '@nestjs/common';
import { type Attributes, type Span, SpanKind, trace } from '@opentelemetry/api';
import { recordError } from '../errors/record';
import { safely } from '../shared/safe';
import { getClassifyDefaults } from './decorators';
import { runInSpan } from './wrap';

@Injectable()
export class TraceService {
  getActiveSpan(): Span | undefined {
    return safely('get active span', () => trace.getActiveSpan(), undefined);
  }

  setAttributes(a: Attributes): void {
    safely('set attributes', () => trace.getActiveSpan()?.setAttributes(a), undefined);
  }

  recordException(err: unknown): void {
    safely(
      'record exception',
      () => {
        const span = trace.getActiveSpan();
        if (span) recordError(span, err, getClassifyDefaults());
      },
      undefined,
    );
  }

  /**
   * Runs `fn` in a new active span. The span ends when the result settles
   * (Promise or Observable aware) and failures are recorded on it.
   */
  startActiveSpan<T>(name: string, fn: (span: Span) => T, opts?: { attributes?: Attributes }): T {
    return runInSpan(name, () => ({ kind: SpanKind.INTERNAL, attributes: opts?.attributes }), getClassifyDefaults, fn);
  }
}
