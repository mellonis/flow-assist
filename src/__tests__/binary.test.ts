import { describe, it, expect } from 'bun:test';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
