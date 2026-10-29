import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Keeps the README's config table in sync with resolveOptions defaults.
it('README documents every OtelModuleOptions default', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const key of [
    'autoInstrument.controllers',
    'autoInstrument.providers',
    'autoInstrument.guards',
    'autoInstrument.interceptors',
    'autoInstrument.pipes',
    'autoInstrument.filters',
    'autoInstrument.include',
    'autoInstrument.exclude',
    'errors.treat4xxAsError',
    'capture.requestBody',
    'capture.responseBody',
    'capture.maxBodyBytes',
    'capture.getUserId',
    'redact.keys',
    'redact.replaceDefaultKeys',
    'redact.patterns',
    'redact.replaceDefaultPatterns',
    'redact.censor',
    'redact.custom',
  ])
    expect(readme).toContain(`\`${key}\``);
});

it('README documents db options', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const key of ['db.captureParams', 'db.maxParamsBytes']) expect(readme).toContain(`\`${key}\``);
  expect(readme).toMatch(/## Databases/);
});

it('README documents bullmq options', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const key of ['bullmq.captureData', 'bullmq.maxDataBytes']) expect(readme).toContain(`\`${key}\``);
  expect(readme).toMatch(/## Queues \(BullMQ\)/);
});
