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
});