import { afterEach, describe, expect, it } from 'vitest';
import { resolveOptions } from '../../src/module/options';
import { getBullmqSettings, resolveBullmqSettings, setBullmqSettings } from '../../src/queue/settings';
import { getGlobalState } from '../../src/shared/global-state';

describe('bullmq settings', () => {
  afterEach(() => {
    getGlobalState().bullmq = undefined;
  });

  it('defaults', () => expect(resolveBullmqSettings()).toEqual({ captureData: 'error', maxDataBytes: 8192 }));
  it('resolveOptions carries bullmq', () => {
    expect(resolveOptions({ bullmq: { captureData: 'never' } }).bullmq.captureData).toBe('never');
    expect(resolveOptions().bullmq).toEqual({ captureData: 'error', maxDataBytes: 8192 });
  });
  it('getBullmqSettings returns defaults until set', () => {
    expect(getBullmqSettings()).toEqual({ captureData: 'error', maxDataBytes: 8192 });
    setBullmqSettings({ captureData: 'always', maxDataBytes: 5 });
    expect(getBullmqSettings()).toEqual({ captureData: 'always', maxDataBytes: 5 });
  });
});
