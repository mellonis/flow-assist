import { describe, it, expect } from 'bun:test';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Distribution smoke test. `bun build --compile` is RETIRED: it produces a
// bundle with two React instances ("Invalid hook call") — an upstream @flowtty
// 1.0.0-alpha + Bun bundler bug. The host therefore ships and runs as a
// Bun-executable via `bun src/cli.ts`. This test pins the real distribution
// contract: the entry is runnable with bun and reports the host version.
describe('distribution', () => {
  it('src/cli.ts is a Bun-executable entry (bun shebang)', () => {
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src.startsWith('#!/usr/bin/env bun')).toBe(true);
  });

  it('bun src/cli.ts --version prints the host version and exits 0', () => {
    expect(execSync('bun src/cli.ts --version', { encoding: 'utf8' }).trim()).toBe('0.0.1');
  });
});
