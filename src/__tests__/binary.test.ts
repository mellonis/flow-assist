import { describe, it, expect } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultToProduction } from '../node-env';

// Distribution smoke test: the entry is runnable with bun and reports the host
// version. (The host also ships as a compiled binary — AGENTS.md, Stack.)
describe('distribution', () => {
  it('src/cli.ts is a Bun-executable entry (bun shebang)', () => {
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src.startsWith('#!/usr/bin/env bun')).toBe(true);
  });

  it('bun src/cli.ts --version prints the host version and exits 0', () => {
    expect(execSync('bun src/cli.ts --version', { encoding: 'utf8' }).trim()).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
  });
});

// React picks its build by NODE_ENV when it is first loaded, and Bun leaves the
// variable unset: the entry defaults it to production before main.ts (and React) is
// imported, and leaves any value already there alone.
describe('which React build runs', () => {
  it('an unset NODE_ENV becomes production; a set one is kept', () => {
    const unset: Record<string, string | undefined> = {};
    defaultToProduction(unset);
    expect(unset.NODE_ENV).toBe('production');
    for (const value of ['test', 'development', '']) {
      const env: Record<string, string | undefined> = { NODE_ENV: value };
      defaultToProduction(env);
      expect(env.NODE_ENV).toBe(value);
    }
  });

  // The binary's React is chosen by the bundler, not at run time: build:binary
  // defines NODE_ENV, so the development build (its `runWithFiberInDEV` wrappers)
  // is not in the binary at all. Built from the script itself, not a copy of it.
  // It compiles a ~60 MB binary, so the regular run skips it: `bun run test:binary`
  // (FLOW_ASSIST_BINARY_TEST=1) runs it — before building a release.
  it.skipIf(!process.env.FLOW_ASSIST_BINARY_TEST)('build:binary compiles the production React, and the binary runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-assist-binary-'));
    try {
      const script: string = JSON.parse(readFileSync('package.json', 'utf8')).scripts['build:binary'];
      const out = join(dir, 'flow-assist');
      expect(script).toContain('--outfile dist/flow-assist');
      execSync(script.replace('--outfile dist/flow-assist', `--outfile ${out}`), { stdio: 'ignore' });
      const binary = readFileSync(out).toString('latin1');
      expect(binary.includes('runWithFiberInDEV')).toBe(false); // a boolean: a failing toContain would print the whole binary
      expect(binary.includes('react/cjs/react.development.js')).toBe(false);
      expect(binary.includes('react/cjs/react.production.js')).toBe(true);
      expect(execSync(`${out} --version`, { encoding: 'utf8' }).trim()).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
