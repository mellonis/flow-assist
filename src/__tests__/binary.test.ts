import { describe, it, expect } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withProductionDefault } from '../node-env';

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
// variable unset: the entry sets it to production while main.ts (and React) loads, and
// puts the person's own state back afterwards, so commands the program starts inherit it.
describe('which React build runs', () => {
  it('the loader sees production when NODE_ENV was unset, and it is unset again afterwards', async () => {
    const env: Record<string, string | undefined> = {};
    let seen: string | undefined;
    await withProductionDefault(env, async () => {
      seen = env.NODE_ENV;
    });
    expect(seen).toBe('production');
    expect('NODE_ENV' in env).toBe(false);
  });

  it('a value the person set is kept during and after the load', async () => {
    for (const value of ['test', 'development', '']) {
      const env: Record<string, string | undefined> = { NODE_ENV: value };
      let seen: string | undefined;
      await withProductionDefault(env, async () => {
        seen = env.NODE_ENV;
      });
      expect(seen).toBe(value);
      expect(env.NODE_ENV).toBe(value);
    }
  });

  it('a loader that throws still puts the environment back, and the error propagates', async () => {
    const env: Record<string, string | undefined> = {};
    await expect(
      withProductionDefault(env, async () => {
        throw new Error('load failed');
      }),
    ).rejects.toThrow('load failed');
    expect('NODE_ENV' in env).toBe(false);
  });

  it('a process started after the entry loaded sees no NODE_ENV when the person had none', () => {
    // The entry's own shape, as a process: the load window, then a child that prints its NODE_ENV.
    const script = `
      import { withProductionDefault } from ${JSON.stringify(join(process.cwd(), 'src/node-env.ts'))};
      import { execSync } from 'node:child_process';
      let during = '';
      await withProductionDefault(process.env, async () => { during = String(process.env.NODE_ENV); });
      const child = execSync('printf "%s" "\${NODE_ENV-unset}"', { encoding: 'utf8' });
      console.log(during + '|' + child);
    `;
    const env = { ...process.env };
    delete env.NODE_ENV;
    expect(execSync(`bun -e '${script.replace(/'/g, `'\\''`)}'`, { env, encoding: 'utf8' }).trim()).toBe('production|unset');
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
