import type { Attributes } from '@opentelemetry/api';
import type { ClassifyOptions } from '../errors/classify';
import { safely } from '../shared/safe';
import { wrapMethod } from './wrap';

export const TRACE_META = '@oxth/nestjs-otel:trace';
export const NO_TRACE_META = '@oxth/nestjs-otel:no-trace';
export const SPAN_ATTR_META = '@oxth/nestjs-otel:span-attr';

export interface SpanParamAttribute {
  index: number;
  name: string;
}

let classifyDefaults: ClassifyOptions = { treat4xxAsError: false };

/** Module-level classification default used by `@Span` and `TraceService`; `OtelModule` sets it. */
export function setClassifyDefaults(o: ClassifyOptions): void {
  classifyDefaults = { ...o };
}

export function getClassifyDefaults(): ClassifyOptions {
  return classifyDefaults;
}

function classNameOf(target: object): string {
  return typeof target === 'function' ? target.name : target.constructor?.name ?? 'Object';
}

/** `@SpanAttribute` entries recorded for `target[key]`, sorted by parameter index. */
export function getSpanParamAttributes(target: object, key: string | symbol): SpanParamAttribute[] | undefined {
  const list = Reflect.getOwnMetadata(SPAN_ATTR_META, target, key) as SpanParamAttribute[] | undefined;
  return list && list.length > 0 ? list : undefined;
}

export function Span(name?: string, opts?: { attributes?: Attributes }): MethodDecorator {
  return (target, key, descriptor) => {
    const original = descriptor.value;
    if (typeof original !== 'function') return descriptor;
    safely(
      '@Span decoration',
      () => {
        const className = classNameOf(target);
        const methodName = String(key);
        descriptor.value = wrapMethod(original as (...a: any[]) => any, {
          spanName: name ?? `${className}.${methodName}`,
          attributes: { 'code.namespace': className, 'code.function': methodName, ...opts?.attributes },
          paramAttributes: getSpanParamAttributes(target, key),
          classify: getClassifyDefaults,
        }) as typeof original;
      },
      undefined,
    );
    return descriptor;
  };
}

function marker(metaKey: string): ClassDecorator & MethodDecorator {
  return ((target: object, _key?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (descriptor) {
      if (typeof descriptor.value === 'function') Reflect.defineMetadata(metaKey, true, descriptor.value);
      return descriptor;
    }
    Reflect.defineMetadata(metaKey, true, target);
    return undefined;
  }) as ClassDecorator & MethodDecorator;
}

/** Marks a class or method for automatic tracing. */
export function Trace(): ClassDecorator & MethodDecorator {
  return marker(TRACE_META);
}

/** Excludes a class or method from automatic tracing. */
export function NoTrace(): ClassDecorator & MethodDecorator {
  return marker(NO_TRACE_META);
}

/** Records a primitive (string, number, boolean) argument as a span attribute. */
export function SpanAttribute(name: string): ParameterDecorator {
  return (target, key, index) => {
    if (key === undefined) return; // constructor parameter: nothing to trace
    const list: SpanParamAttribute[] = [...(Reflect.getOwnMetadata(SPAN_ATTR_META, target, key) ?? [])];
    list.push({ index, name });
    list.sort((a, b) => a.index - b.index);
    Reflect.defineMetadata(SPAN_ATTR_META, list, target, key);
  };
}
