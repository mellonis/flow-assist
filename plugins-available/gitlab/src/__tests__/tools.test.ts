import { describe, it, expect } from 'bun:test';
import { buildGitlabGroup } from '../tools.ts';

describe('gitlab tool group', () => {
  const group = buildGitlabGroup({ clip: (x: unknown) => x, glabAvailable: async () => true, runGlab: async () => '{}' });
  it('write predicate is true only for write methods', () => {
    const glab = group.tools[0];
    expect(glab.write({ method: 'POST' })).toBe(true);
    expect(glab.write({ method: 'GET' })).toBe(false);
  });
  // R14-A: source's valid-method regex is GET/POST/PUT/PATCH/DELETE, so DELETE is
  // VALID (the brief's literal case was wrong). Adapt to a genuinely-invalid method.
  it('validates method and path before running', async () => {
    const out = await group.exec('glab_api', { method: 'FOO', path: '/x' }, {});
    expect(String(out)).toContain('Invalid method');
  });
  // glab's `--field` reads `@path` from a file; a model-spelled value must never
  // reach it. What actually goes to glab is asserted, not only what comes back.
  it('a string value is sent raw, so "@file" is a string and not a file to upload', async () => {
    const calls: string[][] = [];
    const g = buildGitlabGroup({ clip: (x: unknown) => x, glabAvailable: async () => true, runGlab: async (argv) => { calls.push(argv); return '{}'; } });
    await g.exec('glab_api', { method: 'GET', path: 'projects', fields: { search: '@/etc/passwd', per_page: 5, archived: false, labels: ['@a'], '-x': 'flag' } }, {});
    expect(calls).toEqual([[
      'api', '--method', 'GET',
      '--raw-field', 'search=@/etc/passwd',
      '--field', 'per_page=5',
      '--field', 'archived=false',
      '--raw-field', 'labels=["@a"]',
      'projects',
    ]]);
  });
  it('a path that is really a flag never reaches glab', async () => {
    const calls: string[][] = [];
    const g = buildGitlabGroup({ clip: (x: unknown) => x, glabAvailable: async () => true, runGlab: async (argv) => { calls.push(argv); return '{}'; } });
    expect(String(await g.exec('glab_api', { path: '--input=/etc/passwd' }, {}))).toContain('cannot start with "-"');
    expect(calls).toEqual([]);
  });
});