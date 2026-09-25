import { expect, test } from 'bun:test';
import { isRemoteManifest } from '../transport';

test('a manifest is remote when it names a command to run or a socket to connect to', () => {
  expect(isRemoteManifest({ name: 'tutor', run: ['./bin/tutor'] })).toBe(true);
  expect(isRemoteManifest({ name: 'tutor', connect: 'unix:tutor.sock' })).toBe(true);
  expect(isRemoteManifest({ name: 'tutor', run: ['bun', 'src/index.ts'], connect: 'unix:tutor.sock' })).toBe(true);
  // A JS plugin's manifest, an empty command, a command that is not strings, no name.
  expect(isRemoteManifest({ name: 'notes', hostApi: 2 })).toBe(false);
  expect(isRemoteManifest({ name: 'tutor', run: [] })).toBe(false);
  expect(isRemoteManifest({ name: 'tutor', run: ['bun', 1] })).toBe(false);
  expect(isRemoteManifest({ run: ['./bin/tutor'] })).toBe(false);
  expect(isRemoteManifest(null)).toBe(false);
});
