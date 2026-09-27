// The host log: a known secret never lands in it, whoever appends the line.
import { afterEach, expect, test } from 'bun:test';
import { buildSecretSet, setActiveSecrets } from '../../../assistant/secrets.ts';
import { createLogService } from '../log.ts';

afterEach(() => setActiveSecrets(null));

test('a line holding a known secret is kept with the secret taken out', () => {
  const token = 'log-secret-value-000001';
  setActiveSecrets(buildSecretSet({}, { MY_TOKEN: token }));
  const log = createLogService({});
  log.append(`[mcp] header ${token}`);
  expect(log.read()[0]).toEndWith('[mcp] header ‹secret MY_TOKEN›');
});
