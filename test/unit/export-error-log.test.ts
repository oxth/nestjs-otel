import { afterEach, expect, it, vi } from 'vitest';
import { exportErrorLogSize, reportExportError } from '../../src/bootstrap/sdk';

afterEach(() => vi.restoreAllMocks());

it('rate-limit log of export errors keeps at most 100 message prefixes', () => {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (let i = 0; i < 250; i++) reportExportError(new Error(`failure #${i}`));
  expect(exportErrorLogSize()).toBeLessThanOrEqual(100);
  expect(write).toHaveBeenCalledTimes(250);
  // A recent prefix is still rate limited.
  reportExportError(new Error('failure #249'));
  expect(write).toHaveBeenCalledTimes(250);
});
