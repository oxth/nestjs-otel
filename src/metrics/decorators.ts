import { type Attributes, type MetricOptions, metrics } from '@opentelemetry/api';
import { errorType as typeOfError } from '../errors/record';
import { SCOPE_NAME } from '../shared/constants';
import { safely } from '../shared/safe';
import { WRAPPED } from '../shared/symbols';
import { copyMethodMetadata } from '../tracing/copy-metadata';
import { handleResult, isWrapped } from '../tracing/wrap';

type AnyFn = (...a: any[]) => any;
type MetricDecoratorOptions = MetricOptions & { attributes?: Attributes };

/**
 * Copies metadata onto `wrapper`. Metric wrappers deliberately do NOT set the
 * `WRAPPED` flag (which tells auto-instrumentation "a span wrapper is already
 * here"): a metric-only method must still get its auto span. If the original
 * already carries the flag (a `@Span` underneath), it is propagated so the
 * auto-instrumenter doesn't add a second span.
 */
function finish(original: AnyFn, wrapper: AnyFn): void {
  safely('copy method metadata', () => copyMethodMetadata(original, wrapper), undefined);
  if (isWrapped(original)) Object.defineProperty(wrapper, WRAPPED, { value: true, configurable: true });
}

function decorate(label: string, make: (original: AnyFn) => AnyFn): MethodDecorator {
  return (_target, _key, descriptor) => {
    const original = descriptor.value;
    if (typeof original !== 'function') return descriptor;
    safely(
      label,
      () => {
        const wrapper = make(original as AnyFn);
        finish(original as AnyFn, wrapper);
        descriptor.value = wrapper as typeof original;
      },
      undefined,
    );
    return descriptor;
  };
}

/** Adds 1 to a counter each time the method is called (including calls that fail). */
export function Counter(name: string, o?: MetricDecoratorOptions): MethodDecorator {
  const { attributes, ...options } = o ?? {};
  return decorate('@Counter decoration', (original) =>
    function (this: unknown, ...args: unknown[]) {
      safely('count call', () => metrics.getMeter(SCOPE_NAME).createCounter(name, options).add(1, attributes), undefined);
      return original.apply(this, args);
    },
  );
}

/** Records the method's duration in seconds; failures carry `error.type`. */
export function Histogram(name: string, o?: MetricDecoratorOptions): MethodDecorator {
  const { attributes, ...options } = o ?? {};
  return decorate('@Histogram decoration', (original) =>
    function (this: unknown, ...args: unknown[]) {
      const start = safely('histogram start', () => performance.now(), Number.NaN);
      let errorType: string | undefined;
      let recorded = false;
      const onError = (err: unknown) => {
        errorType = safely('error type', () => typeOfError(err), 'Error');
      };
      const onFinally = () => {
        if (recorded) return;
        recorded = true;
        safely(
          'record duration',
          () => {
            const seconds = (performance.now() - start) / 1000;
            if (Number.isNaN(seconds)) return;
            const attrs = errorType === undefined ? attributes : { ...attributes, 'error.type': errorType };
            metrics
              .getMeter(SCOPE_NAME)
              .createHistogram(name, { unit: 's', ...options })
              .record(seconds, attrs);
          },
          undefined,
        );
      };
      let result: unknown;
      try {
        result = original.apply(this, args);
      } catch (err) {
        onError(err);
        onFinally();
        throw err;
      }
      return handleResult(result, { onError, onFinally });
    },
  );
}
