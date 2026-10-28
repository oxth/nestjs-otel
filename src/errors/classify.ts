import { HttpException } from '@nestjs/common';

export interface ClassifyOptions {
  treat4xxAsError: boolean;
}

function getHttpStatus(err: unknown): number | undefined {
  if (err instanceof HttpException) return err.getStatus();
  if (err !== null && typeof err === 'object' && typeof (err as { getStatus?: unknown }).getStatus === 'function') {
    const status = (err as { getStatus: () => unknown }).getStatus();
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

export function classifyError(err: unknown, opts: ClassifyOptions): { isError: boolean; httpStatus?: number } {
  let httpStatus: number | undefined;
  try {
    httpStatus = getHttpStatus(err);
  } catch {
    httpStatus = undefined;
  }
  if (httpStatus === undefined) return { isError: true };
  return { isError: httpStatus >= 500 || opts.treat4xxAsError, httpStatus };
}
