import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');

describe('repo docs', () => {
  it('AGENTS.md exists and sets the English-language rule', () => {
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toMatch(/English/);
  });
  it('CLAUDE.md points at AGENTS.md', () => {
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toMatch(/AGENTS\.md/);
  });
  it('README.md is present', () => {
    expect(existsSync(join(root, 'README.md'))).toBe(true);
  });
});