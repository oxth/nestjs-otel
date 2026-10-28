import type { LogLevel } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { toSeverity } from '../../src/logs/severity';

describe('toSeverity', () => {
  it.each<[LogLevel, number, string]>([
    ['fatal', 21, 'FATAL'],
    ['error', 17, 'ERROR'],
    ['warn', 13, 'WARN'],
    ['log', 9, 'INFO'],
    ['debug', 5, 'DEBUG'],
    ['verbose', 1, 'TRACE'],
  ])('%s → %i %s', (level, severityNumber, severityText) => {
    expect(toSeverity(level)).toEqual({ severityNumber, severityText });
  });
});
