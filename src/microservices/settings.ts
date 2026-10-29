import { DEFAULT_MAX_BODY_BYTES } from '../shared/constants';
import { getGlobalState } from '../shared/global-state';

export type MicroserviceDataCaptureMode = 'error' | 'always' | 'never';

export interface MicroservicesOptions {
  /** When to record the handler's payload on its span. Default `'error'`. Responses are never recorded. */
  captureData?: MicroserviceDataCaptureMode;
  /** Max serialized bytes of the captured payload. Default 8192. */
  maxDataBytes?: number;
}

export interface MicroservicesSettings {
  captureData: MicroserviceDataCaptureMode;
  maxDataBytes: number;
}

export function resolveMicroservicesSettings(o: MicroservicesOptions = {}): MicroservicesSettings {
  return { captureData: o.captureData ?? 'error', maxDataBytes: o.maxDataBytes ?? DEFAULT_MAX_BODY_BYTES };
}

export function getMicroservicesSettings(): MicroservicesSettings {
  return getGlobalState().microservices ?? resolveMicroservicesSettings();
}

export function setMicroservicesSettings(s: MicroservicesSettings): void {
  getGlobalState().microservices = s;
}
