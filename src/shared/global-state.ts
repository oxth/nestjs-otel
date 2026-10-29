export interface SdkHandle {
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

import type { DbSettings } from '../orm/settings';
import type { BullmqSettings } from '../queue/settings';
import type { Redactor } from '../redact/redactor';

export interface GlobalState {
  sdk?: SdkHandle;
  registered: boolean;
  processMonitorInstalled?: boolean;
  warned: Set<string>;
  redactor?: Redactor;
  db?: DbSettings;
  bullmq?: BullmqSettings;
  /** The BullMQ telemetry adapter singleton (shared by CJS and ESM copies). */
  bullmqTelemetry?: object;
  /** Raw text → masked replacement, applied by every redactor's `redactString` (see `registerMaskedText`). */
  maskedTexts?: Map<string, string>;
  /** Set once `@nestjs/microservices` prototypes have been patched (shared by CJS and ESM copies). */
  microservicesPatched?: boolean;
}

const STATE_KEY = Symbol.for('@oxth/nestjs-otel.state');

export function getGlobalState(): GlobalState {
  const g = globalThis as unknown as Record<symbol, GlobalState | undefined>;
  let state = g[STATE_KEY];
  if (!state) {
    state = { registered: false, warned: new Set<string>() };
    g[STATE_KEY] = state;
  }
  return state;
}
