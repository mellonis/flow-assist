import { expect, test } from 'bun:test';
import { hostVersion } from '../version';

test('host reports a semver version', () => {
  expect(hostVersion()).toMatch(/^\d+\.\d+\.\d+/);
});