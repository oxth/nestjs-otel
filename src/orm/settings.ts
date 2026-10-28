import { getGlobalState } from '../shared/global-state';

export type DbCaptureMode = 'error' | 'always' | 'never';

export interface DbOptions {
  /** When to record query parameters. Default `'error'`. */
  captureParams?: DbCaptureMode;
  /** Max serialized bytes of captured parameters. Default 2048. */
  maxParamsBytes?: number;
}

export interface DbSettings {
  captureParams: DbCaptureMode;
  maxParamsBytes: number;
}

export function resolveDbSettings(o: DbOptions = {}): DbSettings {
  return { captureParams: o.captureParams ?? 'error', maxParamsBytes: o.maxParamsBytes ?? 2048 };
}

export function getDbSettings(): DbSettings {
  return getGlobalState().db ?? resolveDbSettings();
}

export function setDbSettings(s: DbSettings): void {
  getGlobalState().db = s;
}
