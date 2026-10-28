export interface SdkHandle {
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

export interface GlobalState {
  sdk?: SdkHandle;
  registered: boolean;
  warned: Set<string>;
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
