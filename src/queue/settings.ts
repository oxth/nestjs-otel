import { DEFAULT_MAX_BODY_BYTES } from '../shared/constants';
import { getGlobalState } from '../shared/global-state';

export type JobDataCaptureMode = 'error' | 'always' | 'never';

export interface BullmqOptions {
  /** When to record job data on the `process` span. Default `'error'`. */
  captureData?: JobDataCaptureMode;
  /** Max serialized bytes of captured job data. Default 8192. */
  maxDataBytes?: number;
}

export interface BullmqSettings {
  captureData: JobDataCaptureMode;
  maxDataBytes: number;
}

export function resolveBullmqSettings(o: BullmqOptions = {}): BullmqSettings {
  return { captureData: o.captureData ?? 'error', maxDataBytes: o.maxDataBytes ?? DEFAULT_MAX_BODY_BYTES };
}

export function getBullmqSettings(): BullmqSettings {
  return getGlobalState().bullmq ?? resolveBullmqSettings();
}

export function setBullmqSettings(s: BullmqSettings): void {
  getGlobalState().bullmq = s;
}
