import {
  InstrumentationBase,
  type InstrumentationConfig,
  InstrumentationNodeModuleDefinition,
} from '@opentelemetry/instrumentation';
import { type MethodWrapper, patchMethods, unpatchMethods } from '../orm/patch';
import { PACKAGE_VERSION } from '../shared/constants';
import { safely } from '../shared/safe';
import { getBullmqTelemetry } from './bullmq-telemetry';
import { runProcessJob } from './process-job';

const protoOf = (moduleExports: any, name: string): object | undefined =>
  safely(`bullmq ${name}`, () => moduleExports?.[name]?.prototype, undefined);

const TRACE = ['trace'] as const;
const CALL_PROCESS_JOB = ['callProcessJob'] as const;

/** Gives the instance the library adapter unless the app already set `opts.telemetry`. */
const traceWrapper: MethodWrapper = (original) =>
  function (this: any, ...args: unknown[]) {
    safely(
      'bullmq default telemetry',
      () => {
        if (this && typeof this === 'object') {
          this.opts ??= {};
          if (this.opts.telemetry === undefined || this.opts.telemetry === null) {
            this.opts.telemetry = getBullmqTelemetry();
          }
        }
      },
      undefined,
    );
    return original.apply(this, args);
  };

const callProcessJobWrapper: MethodWrapper = (original) =>
  function (this: any, job: unknown, ...rest: unknown[]) {
    return runProcessJob(this, job, () => original.call(this, job, ...rest));
  };

function patchFlowProducer(proto: object | undefined): void {
  if (!proto || Object.hasOwn(proto, 'telemetry')) return;
  Object.defineProperty(proto, 'telemetry', {
    configurable: true,
    enumerable: false,
    get() {
      return getBullmqTelemetry();
    },
    set(value: unknown) {
      Object.defineProperty(this, 'telemetry', { value, writable: true, enumerable: true, configurable: true });
    },
  });
}

export function patchBullmq(moduleExports: any): void {
  safely(
    'patch bullmq',
    () => {
      patchMethods(protoOf(moduleExports, 'QueueBase'), TRACE, traceWrapper);
      patchMethods(protoOf(moduleExports, 'Worker'), CALL_PROCESS_JOB, callProcessJobWrapper);
      patchFlowProducer(protoOf(moduleExports, 'FlowProducer'));
    },
    undefined,
  );
}

export function unpatchBullmq(moduleExports: any): void {
  safely(
    'unpatch bullmq',
    () => {
      unpatchMethods(protoOf(moduleExports, 'QueueBase'), TRACE);
      unpatchMethods(protoOf(moduleExports, 'Worker'), CALL_PROCESS_JOB);
      const fp = protoOf(moduleExports, 'FlowProducer');
      if (fp && Object.hasOwn(fp, 'telemetry')) delete (fp as Record<string, unknown>).telemetry;
    },
    undefined,
  );
}

export class BullmqInstrumentation extends InstrumentationBase {
  constructor(config: InstrumentationConfig = {}) {
    super('@oxth/nestjs-otel/instrumentation-bullmq', PACKAGE_VERSION, config);
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition(
      'bullmq',
      ['>=5.24.0 <7'],
      (moduleExports) => {
        patchBullmq(moduleExports);
        return moduleExports;
      },
      (moduleExports) => unpatchBullmq(moduleExports),
    );
  }
}
