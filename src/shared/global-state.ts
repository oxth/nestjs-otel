export interface SdkHandle {
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

import type { DbSettings } from '../orm/settings';
import type { Redactor } from '../redact/redactor';

export interface GlobalState {
  sdk?: SdkHandle;
  registered: boolean;
  processMonitorInstalled?: boolean;
  warned: Set<string>;
  redactor?: Redactor;
  db?: DbSettings;
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
