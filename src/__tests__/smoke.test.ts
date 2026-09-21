import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { hostVersion } from '../version';

test('host reports a semver version', () => {
  expect(hostVersion()).toMatch(/^\d+\.\d+\.\d+/);
});
test('the host version is the one in package.json', () => {
  expect(hostVersion()).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
});
