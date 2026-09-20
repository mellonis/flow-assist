import { describe, it, expect } from 'bun:test';
import { buildRepoGroup } from '../tools.ts';

describe('repo tool group', () => {
  it('detect is false with no roots configured', async () => {
    const group = buildRepoGroup({ clip: (x: unknown) => x, roots: [] });
    expect(await group.detect()).toBe(false);
  });
  it('read_file rejects paths outside the roots', async () => {
    const group = buildRepoGroup({ clip: (x: unknown) => x, roots: ['/tmp/r'], homeDir: '/home/u' });
    const out = await group.exec('read_file', { path: '/etc/passwd' }, {});
    expect(String(out)).toContain('outside');
  });
});