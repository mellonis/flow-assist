// run_command's own checks: where it may run, and what the model is told about the
// machine. The y/n and the background refusal are the chat's — shell.e2e.test.ts.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShellState } from '../../assistant/shell.ts';
import { commandCwd, platformLine, probePrograms, runCommandDescription, shellTools } from '../tools-shell.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-runcmd-')));

test('the cwd defaults to the first root; with no roots, to the process directory', () => {
  const root = tmp();
  expect(commandCwd({ fs: { roots: [root] } }, undefined)).toBe(root);
  expect(commandCwd({}, '')).toBe(process.cwd());
});

test('shell.roots is where run_command starts and what it stays inside; fs.roots only when it is unset', () => {
  const root = tmp();
  const other = tmp();
  const config = { shell: { roots: [root] }, fs: { roots: [other] } };
  expect(commandCwd(config, undefined)).toBe(root);
  expect(() => commandCwd(config, other)).toThrow(/outside the configured roots/);
  expect(commandCwd({ fs: { roots: [other] } }, undefined)).toBe(other);
  // With no roots at all, the refusal names the key to set.
  expect(() => commandCwd({}, '/tmp')).toThrow(/shell\.roots/);
  expect(runCommandDescription(config)).toContain(`It starts at ${root}`);
});

test('a cwd inside a root is taken, relative to the current directory or absolute', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.mkdirSync(path.join(root, 'pkg', 'src'));
  expect(commandCwd({ fs: { roots: [root] } }, 'pkg')).toBe(path.join(root, 'pkg'));
  expect(commandCwd({ fs: { roots: [root] } }, path.join(root, 'pkg'))).toBe(path.join(root, 'pkg'));
  expect(commandCwd({ fs: { roots: [root] } }, 'src', path.join(root, 'pkg'))).toBe(path.join(root, 'pkg', 'src'));
  expect(commandCwd({ fs: { roots: [root] } }, '..', path.join(root, 'pkg'))).toBe(root);
});

test('the cwd argument is a cd — it stays; a cd inside the command stays too', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a'));
  fs.mkdirSync(path.join(root, 'b'));
  const config = { fs: { roots: [root] } };
  const shell = createShellState(() => config);
  const g = shellTools(config);
  await g.exec('run_command', { command: 'true', cwd: 'a' }, { shell } as never);
  expect(shell.cwd()).toBe(path.join(root, 'a'));
  const out = await g.exec('run_command', { command: 'cd ../b' }, { shell } as never);
  expect(shell.cwd()).toBe(path.join(root, 'b'));
  expect(out).toContain(`Ran in ${path.join(root, 'a')}`);
  expect(out).toContain(`Directory now: ${path.join(root, 'b')}`);
  const refused = await g.exec('run_command', { command: 'cd /' }, { shell } as never);
  expect(refused).toContain('cd led outside the roots');
  expect(shell.cwd()).toBe(path.join(root, 'b'));
});

test('a cwd outside the roots is refused by THROWING', () => {
  const root = tmp();
  expect(() => commandCwd({ fs: { roots: [root] } }, '/etc')).toThrow(/outside the configured roots/);
  expect(() => commandCwd({ fs: { roots: [root] } }, '../..')).toThrow(/outside the configured roots/);
  expect(() => commandCwd({}, '/tmp')).toThrow(/no roots are configured/);
  expect(() => commandCwd({ fs: { roots: [root] } }, 'missing')).toThrow(/not a directory/);
});

test('a symlink in the clone that points out of it is refused', () => {
  const root = tmp();
  const outside = tmp();
  fs.symlinkSync(outside, path.join(root, 'escape'));
  expect(() => commandCwd({ fs: { roots: [root] } }, 'escape')).toThrow(/resolves through a link/);
});

test('a refusal throws from exec too — a write tool that returns is counted as done', async () => {
  const root = tmp();
  const g = shellTools({ fs: { roots: [root] } });
  await expect(g.exec('run_command', { command: 'echo hi', cwd: '/etc' }, {} as never)).rejects.toThrow(/outside/);
  await expect(g.exec('run_command', { command: '  ' }, {} as never)).rejects.toThrow(/command is required/);
  // A failing command is a RESULT: the model needs to see the failing test.
  const out = await g.exec('run_command', { command: 'echo boom; exit 2' }, {} as never);
  expect(out).toContain('(exit 2');
  expect(out).toContain('boom');
  expect(out).toContain(`Ran in ${root}`);
});

test('every call is a write — it pauses for the y/n', () => {
  expect(shellTools({}).tools[0]!.write).toBe(true);
});

test('the description tells the model the machine: platform, default cwd, what is installed', () => {
  const root = tmp();
  const d = runCommandDescription({ fs: { roots: [root] } });
  expect(d).toContain(platformLine());
  expect(d).toContain(`It starts at ${root}`);
  expect(d).toContain('remembered between calls');
  expect(d).toMatch(/Installed: [^.]*\bgit\b/);
  expect(d).toContain('package.json scripts');
  expect(platformLine('darwin', 'arm64')).toContain("sed -i ''");
  expect(platformLine('linux', 'x64')).toBe('Linux x64');
});

test('the probe finds programs on PATH and does not throw on an empty PATH', () => {
  expect(probePrograms()).toContain('git');
  expect(probePrograms({ PATH: '' })).toEqual([]);
});

test('run_command opens its view and fills it as the command prints', async () => {
  const states: { text: string; exitCode?: number | null }[] = [];
  const ctx = {
    liveView: (kind: string, data: { text: string }) => {
      expect(kind).toBe('console');
      states.push(data);
      return { update: (d: { text: string; exitCode?: number | null }) => states.push(d), discard() {} };
    },
  };
  const out = await shellTools({}).exec('run_command', { command: 'printf a; sleep 0.2; printf b' }, ctx as never);
  expect(states[0]!.text).toBe('');
  expect(states.some((s) => s.text === 'a')).toBe(true);
  expect(states.at(-1)).toMatchObject({ text: 'ab', exitCode: 0 });
  expect(out).toContain('ab');
});

// ─── cd: the model moves the shell's directory ───────────────────────────────
test('cd is a read-only tool of the shell group', () => {
  const def = shellTools({ shell: { roots: [tmp()] } }).tools.find((t) => t.function.name === 'cd');
  expect(def).toBeDefined();
  expect((def as { write?: unknown }).write).toBeUndefined();
  expect(def!.function.parameters).toMatchObject({ required: ['path'] });
});

test('cd moves the conversation\'s directory — relative to it or absolute — and names what it found', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'proj', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proj', 'AGENTS.md'), 'proj rules');
  const config = { shell: { roots: [root] } };
  const shell = createShellState(() => config);
  const g = shellTools(config);
  const out = await g.exec('cd', { path: 'proj' }, { shell } as never);
  expect(shell.cwd()).toBe(path.join(root, 'proj'));
  expect(shell.saved()).toBe(path.join(root, 'proj')); // what the session keeps
  expect(out).toContain(`now in ${path.join(root, 'proj')}`);
  expect(out).toContain(path.join(root, 'proj', 'AGENTS.md'));
  await g.exec('cd', { path: 'src' }, { shell } as never);
  expect(shell.cwd()).toBe(path.join(root, 'proj', 'src'));
  const back = await g.exec('cd', { path: root }, { shell } as never);
  expect(shell.cwd()).toBe(root);
  expect(back).toContain(`now in ${root}`);
  expect(back).toContain(`no AGENTS.md between here and ${root}`);
});

test('cd outside the roots is a tool error naming the roots, and the directory stays', async () => {
  const root = tmp();
  const other = tmp();
  fs.mkdirSync(path.join(root, 'a'));
  fs.symlinkSync(other, path.join(root, 'out'));
  const config = { shell: { roots: [root] } };
  const shell = createShellState(() => config);
  const g = shellTools(config);
  await g.exec('cd', { path: 'a' }, { shell } as never);
  await expect(g.exec('cd', { path: other }, { shell } as never)).rejects.toThrow(root);
  await expect(g.exec('cd', { path: '../..' }, { shell } as never)).rejects.toThrow(/outside the configured roots/);
  await expect(g.exec('cd', { path: '../out' }, { shell } as never)).rejects.toThrow(root); // a link out
  await expect(g.exec('cd', { path: 'missing' }, { shell } as never)).rejects.toThrow(/not a directory/);
  await expect(g.exec('cd', { path: ' ' }, { shell } as never)).rejects.toThrow(/path is required/);
  expect(shell.cwd()).toBe(path.join(root, 'a'));
});

test('cd with no roots configured is refused and names the key to set', async () => {
  const shell = createShellState(() => ({}));
  await expect(shellTools({}).exec('cd', { path: os.tmpdir() }, { shell } as never)).rejects.toThrow(/shell\.roots/);
});

test('the shell state says every time its directory is set', () => {
  const seen: (string | null)[] = [];
  const shell = createShellState(() => ({}), null, (d) => seen.push(d));
  shell.setCwd('/x');
  shell.setCwd(null);
  expect(seen).toEqual(['/x', null]);
});
