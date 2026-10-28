import type { LogLevel } from '@nestjs/common';
import { SeverityNumber } from '@opentelemetry/api';

const SEVERITY: Record<LogLevel, { severityNumber: SeverityNumber; severityText: string }> = {
  fatal: { severityNumber: SeverityNumber.FATAL, severityText: 'FATAL' },
  error: { severityNumber: SeverityNumber.ERROR, severityText: 'ERROR' },
  warn: { severityNumber: SeverityNumber.WARN, severityText: 'WARN' },
  log: { severityNumber: SeverityNumber.INFO, severityText: 'INFO' },
  debug: { severityNumber: SeverityNumber.DEBUG, severityText: 'DEBUG' },
  verbose: { severityNumber: SeverityNumber.TRACE, severityText: 'TRACE' },
};

export function toSeverity(level: LogLevel): { severityNumber: SeverityNumber; severityText: string } {
  return { ...(SEVERITY[level] ?? SEVERITY.log) };
}
