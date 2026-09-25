// The protocol is part of the host API, and the package that carries it ships with the
// host: both numbers are held here, as the bundled plugins' versions are.
import { expect, test } from 'bun:test';
import { PROTOCOL_HOST_API } from '@flow-assist/remote';
import { HOST_API, hostVersion } from '../version';
import pkg from '../../packages/remote/package.json';

test('the protocol number is the host API number', () => {
  expect(PROTOCOL_HOST_API).toBe(HOST_API);
});

test('@flow-assist/remote carries the host version', () => {
  expect(pkg.version).toBe(hostVersion());
  expect(pkg.name).toBe('@flow-assist/remote');
});
