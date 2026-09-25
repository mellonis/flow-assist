// What `bun publish` ships is what an author installs: the build with its `.d.ts`, the
// sources the `bun` condition points at, never the tests.
import { expect, test } from 'bun:test';
import path from 'node:path';
import pkg from '../../package.json';
import tsconfig from '../../tsconfig.json';

const dir = path.resolve(import.meta.dir, '../..');

test('the package ships its build and the sources its bun condition names, without the tests', () => {
  expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'src', '!src/**/__tests__']));
  expect(pkg.exports['.'].bun.startsWith('./src/')).toBe(true);
  expect(pkg.main.startsWith('./dist/')).toBe(true);
  expect(pkg.scripts.prepublishOnly).toBe('tsc -p tsconfig.json');
  expect(tsconfig.exclude).toContain('src/**/__tests__');
});

test('the package builds on its own: tsc finds the bun types', () => {
  const tsc = path.resolve(dir, '../../node_modules/.bin/tsc');
  const r = Bun.spawnSync([tsc, '-p', 'tsconfig.json', '--noEmit'], { cwd: dir });
  expect(r.stdout.toString() + r.stderr.toString()).toBe('');
  expect(r.exitCode).toBe(0);
});
