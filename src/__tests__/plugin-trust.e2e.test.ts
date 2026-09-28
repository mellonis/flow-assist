// A plugin in plugins-enabled/ loads only when the person trusts it (src/loader/trust.ts):
// one linked there by a command after the first start is not loaded — none of its code
// runs — and is named with the command that trusts it.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins } from '../loader/build';
import { createPluginRepo } from '../loader/repo';
import { hostGroupTools } from '../loader/host-group';
import type { Untrusted } from '../loader/trust';
import { runPlugins } from '../main';
import { MODEL_SHELL_ENV } from '../config/load';
import { HOST_API } from '../version';
import { ScriptedModel, bootApp } from './helpers/scripted';

afterEach(() => {
  delete process.env[MODEL_SHELL_ENV];
  process.exitCode = 0;
});

// An install root; each plugin writes `<name>.ran` beside it when its module runs.
function install() {
  const root = mkdtempSync(join(tmpdir(), 'fa-trust-'));
  const availableDir = join(root, 'plugins-available');
  const enabledDir = join(root, 'plugins-enabled');
  mkdirSync(availableDir, { recursive: true });
  mkdirSync(enabledDir, { recursive: true });
  const repo = createPluginRepo({ availableDir, enabledDir, projectRoot: root });
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const cli = (...args: string[]) => runPlugins(args, {}, repo, { availableDir, enabledDir, io });
  const load = async () => {
    const notes: string[] = [];
    const untrusted: Untrusted[] = [];
    const warn = console.warn;
    console.warn = () => {};
    const plugins = await loadPlugins({ config: {}, repo, enabledDir, notes, untrusted }).finally(() => { console.warn = warn; });
    return { names: plugins.map((p) => p.name), notes, untrusted };
  };
  const ran = (name: string) => existsSync(join(root, `${name}.ran`));
  return { root, availableDir, enabledDir, repo, out, err, cli, load, ran };
}

// A plugin directory at `dir`, whose module leaves a mark in `root` when it runs.
function pluginAt(dir: string, name: string, root: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name, version: '1.0.0', hostApi: HOST_API }));
  writeFileSync(join(dir, 'index.ts'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, `${name}.ran`))}, 'ran');\nexport default () => ({ name: ${JSON.stringify(name)} });\n`);
  return dir;
}

test('the first start trusts what is enabled, once, and says so; a link a command adds later is not loaded until `plugins trust`', async () => {
  const d = install();
  symlinkSync(pluginAt(join(d.availableDir, 'alpha'), 'alpha', d.root), join(d.enabledDir, 'alpha'));
  // A plugin kept in a repository of its own, linked from outside.
  symlinkSync(pluginAt(join(d.root, 'elsewhere', 'beta'), 'beta', d.root), join(d.enabledDir, 'beta'));

  const first = await d.load();
  expect(first.names).toEqual(expect.arrayContaining(['alpha', 'beta']));
  expect(first.notes.filter((n) => n.startsWith('[plugins] trusted at first start:'))).toHaveLength(1);
  expect(first.notes.find((n) => n.startsWith('[plugins] trusted at first start:'))).toMatch(/alpha.*beta|beta.*alpha/);
  const again = await d.load();
  expect(again.names).toEqual(expect.arrayContaining(['alpha', 'beta']));
  expect(again.notes.some((n) => n.includes('trusted at first start'))).toBe(false);

  // A command links a plugin in.
  symlinkSync(pluginAt(join(d.root, 'dropped', 'evil'), 'evil', d.root), join(d.enabledDir, 'evil'));
  const next = await d.load();
  expect(next.names).not.toContain('evil');
  expect(d.ran('evil')).toBe(false);
  expect(next.untrusted).toEqual([{ name: 'evil' }]);
  expect(next.notes).toContain('[plugins] skip evil: not trusted — flow-assist plugins trust evil');

  await d.cli('ls');
  expect(d.out.find((l) => l.startsWith('evil '))).toContain('[active, not trusted — flow-assist plugins trust evil]');

  await d.cli('trust', 'evil');
  expect(d.out.at(-1)).toMatch(/^plugin 'evil' trusted \(.+evil\) — restart/);
  const trusted = await d.load();
  expect(trusted.names).toContain('evil');
  expect(d.ran('evil')).toBe(true);
});

test('the start screen names an untrusted plugin with the command that trusts it', async () => {
  const model = new ScriptedModel();
  const ui = await bootApp(model, 110, 28, undefined, {}, { untrusted: ['evil'] });
  expect(ui.backend.lastFrame).toContain('plugins');
  expect(ui.backend.lastFrame).toContain('evil  not trusted — flow-assist plugins trust evil');
  ui.app.unmount();
});

test('a trusted link retargeted elsewhere is untrusted again', async () => {
  const d = install();
  symlinkSync(pluginAt(join(d.availableDir, 'alpha'), 'alpha', d.root), join(d.enabledDir, 'alpha'));
  expect((await d.load()).names).toContain('alpha');
  rmSync(join(d.root, 'alpha.ran'));
  unlinkSync(join(d.enabledDir, 'alpha'));
  const other = pluginAt(join(d.root, 'swapped', 'alpha'), 'alpha', d.root);
  symlinkSync(other, join(d.enabledDir, 'alpha'));
  const after = await d.load();
  expect(after.names).not.toContain('alpha');
  expect(d.ran('alpha')).toBe(false);
  expect(after.untrusted[0]).toMatchObject({ name: 'alpha' });
  expect(after.untrusted[0]!.movedTo).toContain('swapped');
  expect(after.notes.find((n) => n.startsWith('[plugins] skip alpha:'))).toContain('its link leads to');
});

test('from a command the model runs, `plugins trust` is refused and a first check trusts nothing', async () => {
  const d = install();
  symlinkSync(pluginAt(join(d.availableDir, 'alpha'), 'alpha', d.root), join(d.enabledDir, 'alpha'));
  process.env[MODEL_SHELL_ENV] = '1';
  // No record yet: the model's command does not get to be the first start.
  const inShell = await d.load();
  expect(inShell.names).not.toContain('alpha');
  await d.cli('trust', 'alpha');
  expect(process.exitCode).toBe(1);
  expect(d.err.at(-1)).toContain('a command the assistant runs cannot trust a plugin');
  expect((await d.load()).names).not.toContain('alpha');
  delete process.env[MODEL_SHELL_ENV];
  process.exitCode = 0;
  // The person's own start is the first one.
  expect((await d.load()).names).toContain('alpha');
});

test('an archive installed through the CLI is trusted and loads; from the model\'s command it is installed but not trusted', async () => {
  const d = install();
  await d.load(); // the first start, with nothing enabled
  const src = mkdtempSync(join(tmpdir(), 'fa-trust-src-'));
  pluginAt(join(src, 'notes'), 'notes', d.root);
  const archive = join(mkdtempSync(join(tmpdir(), 'fa-trust-tgz-')), 'notes-1.0.0.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', src, 'notes']);
  await d.cli('install', archive);
  expect(d.out.at(-1)).toContain("plugin 'notes' v1.0.0 installed");
  expect((await d.load()).names).toContain('notes');

  pluginAt(join(src, 'other'), 'other', d.root);
  const second = join(mkdtempSync(join(tmpdir(), 'fa-trust-tgz-')), 'other-1.0.0.tar.gz');
  execFileSync('tar', ['-czf', second, '-C', src, 'other']);
  process.env[MODEL_SHELL_ENV] = '1';
  await d.cli('install', second);
  delete process.env[MODEL_SHELL_ENV];
  expect(d.err.at(-1)).toContain("plugin 'other' is not trusted");
  const loaded = await d.load();
  expect(loaded.names).not.toContain('other');
  expect(loaded.untrusted.map((u) => u.name)).toContain('other');
});

test('a kit update — the directory removed, a newer archive unpacked in its place, the relative link made again — keeps the plugin trusted', async () => {
  const d = install();
  const src = mkdtempSync(join(tmpdir(), 'fa-kit-src-'));
  pluginAt(join(src, 'tracker'), 'tracker', d.root);
  const archive = join(mkdtempSync(join(tmpdir(), 'fa-kit-tgz-')), 'tracker-1.0.0.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', src, 'tracker']);
  // The kit's installer, step for step: no binary involved.
  const kit = () => {
    rmSync(join(d.availableDir, 'tracker'), { recursive: true, force: true });
    execFileSync('tar', ['-xzf', archive, '-C', d.availableDir]);
    execFileSync('ln', ['-sfn', '../plugins-available/tracker', join(d.enabledDir, 'tracker')]);
  };
  kit();
  expect((await d.load()).names).toContain('tracker');
  kit();
  const after = await d.load();
  expect(after.names).toContain('tracker');
  expect(after.untrusted).toEqual([]);
});

test('`plugins remove` forgets the trust: the link put back by a command is not loaded', async () => {
  const d = install();
  const dir = pluginAt(join(d.availableDir, 'alpha'), 'alpha', d.root);
  symlinkSync(dir, join(d.enabledDir, 'alpha'));
  expect((await d.load()).names).toContain('alpha');
  await d.cli('remove', 'alpha');
  symlinkSync(dir, join(d.enabledDir, 'alpha'));
  expect((await d.load()).names).not.toContain('alpha');
});

test('a plugin the model installs through host:plugins_install is installed but not trusted, and the result says how to trust it', async () => {
  const d = install();
  await d.load();
  pluginAt(join(d.availableDir, 'gamma'), 'gamma', d.root);
  const group = hostGroupTools(d.repo);
  const res = String(await group.exec('host:plugins_install', { name: 'gamma' }, {} as never));
  expect(res).toContain('installed but not trusted');
  expect(res).toContain('flow-assist plugins trust gamma');
  expect(existsSync(join(d.enabledDir, 'gamma'))).toBe(true);
  expect((await d.load()).names).not.toContain('gamma');
});
