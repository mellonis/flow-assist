// Where `repo` takes its roots from, and that its key is its own: `plugins.repo.roots`,
// else the shell's `shell.roots`, else the legacy `fs.roots`, a setting `shell.roots`
// and `plugins.repo.roots` replace. The builder is called as the host calls it (its `make`, its zod), and
// `config set` is validated through the host's own validator with repo's schema.
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { validateConfigWriteValue } from '../../../../src/config/load.ts';
import { hostConfigSchema } from '../../../../src/config/schema.ts';
import { makeFactory } from '../../../../src/loader/plugin.ts';
import { buildRepoPlugin, repoRoots } from '../index.ts';

const tmp = (file: string) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-repo-roots-')));
  fs.writeFileSync(path.join(dir, file), 'x');
  return dir;
};

function build(config: Record<string, unknown>) {
  return buildRepoPlugin({ renders: {}, config, make: makeFactory(config as never), z }) as any;
}
// What list_dir shows with no path: the first root's entries.
const firstRootListing = async (config: Record<string, unknown>) =>
  String(await build(config).tools[0].exec('list_dir', {}, {}));

describe('repo roots', () => {
  it('plugins.repo.roots wins, then shell.roots, then fs.roots', () => {
    expect(repoRoots({ plugins: { repo: { roots: ['/r'] } }, shell: { roots: ['/s'] }, fs: { roots: ['/f'] } })).toEqual(['/r']);
    expect(repoRoots({ shell: { roots: ['/s'] }, fs: { roots: ['/f'] } })).toEqual(['/s']);
    expect(repoRoots({ plugins: { repo: {} }, shell: { timeoutMs: 1000 }, fs: { roots: ['/f'] } })).toEqual(['/f']);
    expect(repoRoots({})).toEqual([]);
    // Set is set, even empty: an explicit [] gives repo no roots at all.
    expect(repoRoots({ plugins: { repo: { roots: [] } }, shell: { roots: ['/s'] } })).toEqual([]);
  });

  it('the tools read the resolved roots — each key in its turn', async () => {
    const r = tmp('from-repo.txt');
    const s = tmp('from-shell.txt');
    const f = tmp('from-fs.txt');
    expect(await firstRootListing({ plugins: { repo: { roots: [r] } }, shell: { roots: [s] }, fs: { roots: [f] } })).toContain('from-repo.txt');
    expect(await firstRootListing({ shell: { roots: [s] }, fs: { roots: [f] } })).toContain('from-shell.txt');
    // A config that still says only fs.roots works the same way.
    expect(await firstRootListing({ fs: { roots: [f] } })).toContain('from-fs.txt');
    expect(await firstRootListing({})).toContain('no read roots configured');
  });

  it('the config object is read on each call, not fixed at build', async () => {
    const a = tmp('a.txt');
    const b = tmp('b.txt');
    const config: Record<string, any> = { shell: { roots: [a] } };
    const group = build(config).tools[0];
    expect(String(await group.exec('list_dir', {}, {}))).toContain('a.txt');
    config.plugins = { repo: { roots: [b] } };
    expect(String(await group.exec('list_dir', {}, {}))).toContain('b.txt');
  });

  it('config set plugins.repo.roots is validated by repo\'s own schema', () => {
    const plugin = build({});
    expect(plugin.config).toEqual({});
    const plugins = { repo: plugin.configSchema };
    expect(validateConfigWriteValue(hostConfigSchema, 'plugins.repo.roots', ['/w'], plugins)).toEqual({ ok: true, value: ['/w'] });
    expect(validateConfigWriteValue(hostConfigSchema, 'plugins.repo.roots', '/w', plugins).ok).toBe(false);
    expect(validateConfigWriteValue(hostConfigSchema, 'plugins.repo.roots', [1], plugins).ok).toBe(false);
    expect(validateConfigWriteValue(hostConfigSchema, 'plugins.repo.nope', true, plugins).ok).toBe(false);
  });

  it('builds without a zod (an older host) — no schema, the roots still resolve', async () => {
    const f = tmp('old-host.txt');
    const config = { fs: { roots: [f] } };
    const plugin = buildRepoPlugin({ renders: {}, config, make: makeFactory(config as never) }) as any;
    expect(plugin.configSchema).toBeUndefined();
    expect(String(await plugin.tools[0].exec('list_dir', {}, {}))).toContain('old-host.txt');
  });
});
