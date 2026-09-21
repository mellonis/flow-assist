// The runner on real processes: `sh -c` is fast, and only a real process group proves
// that a timeout or an abort ends what the command started, not just the shell.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShellState, dirAllowed, formatShell, nextCwd, runShell, shellCwd, shellLimits, tildePath } from '../shell.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-shell-')));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const until = async (cond: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return cond();
};

test('output and exit code', async () => {
  const r = await runShell('echo hi', { cwd: tmp() });
  expect(r).toMatchObject({ code: 0, output: 'hi\n', cut: 0, timedOut: false, stopped: false });
});

test('stderr is merged with stdout, in the order it came', async () => {
  const r = await runShell('echo one; sleep 0.05; echo two >&2; sleep 0.05; echo three', { cwd: tmp() });
  expect(r.output).toBe('one\ntwo\nthree\n');
});

test('a non-zero exit is reported, not thrown', async () => {
  const r = await runShell('echo failing >&2; exit 3', { cwd: tmp() });
  expect(r.code).toBe(3);
  expect(r.output).toBe('failing\n');
});

test('a long output keeps its TAIL and counts what was cut from the start', async () => {
  // 30000 chars of "a" and then the part that matters.
  const r = await runShell(`head -c 30000 /dev/zero | tr '\\0' a; echo; echo THE END`, { cwd: tmp(), maxChars: 1000 });
  expect(r.output.length).toBe(1000);
  expect(r.output.endsWith('THE END\n')).toBe(true);
  expect(r.cut).toBe(30000 + 1 + 8 - 1000);
  const { display, forModel } = formatShell('x', r, '/w');
  expect(display).toContain(`first ${r.cut} chars cut`);
  expect(forModel).toContain('the end is kept');
});

test('a timeout kills the command AND what it started, and returns at once', async () => {
  const t0 = Date.now();
  const r = await runShell('sleep 30 & sleep 30', { cwd: tmp(), timeoutMs: 300 });
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(r.timedOut).toBe(true);
  expect(r.code).toBeNull();
  // The whole group is gone — the backgrounded `sleep` included.
  expect(await until(() => !groupAlive(r.pid!))).toBe(true);
  expect(formatShell('sleep', r, '/w', 300).display).toContain('timed out after 0.3 s');
});

test('an abort (Esc) stops it and says so', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const t0 = Date.now();
  const r = await runShell('sleep 30', { cwd: tmp(), signal: ac.signal });
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(r.stopped).toBe(true);
  expect(await until(() => !alive(r.pid!))).toBe(true);
  expect(formatShell('sleep 30', r, '/w').display).toContain('stopped (Esc)');
});

test('a job left running with & does not hold the result', async () => {
  const t0 = Date.now();
  const r = await runShell('echo started; sleep 30 &', { cwd: tmp() });
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(r).toMatchObject({ code: 0, output: 'started\n' });
});

test('runs in the cwd it is given; no stdin, pagers are cat, git never prompts', async () => {
  const dir = tmp();
  const r = await runShell('pwd; echo "$PAGER $GIT_PAGER $GIT_TERMINAL_PROMPT"; cat; echo done', { cwd: dir });
  expect(r.output).toBe(`${dir}\ncat cat 0\ndone\n`);
});

test('the cwd is the first root when it is a directory, else the process directory', () => {
  const dir = tmp();
  expect(shellCwd({ fs: { roots: [dir, '/elsewhere'] } })).toBe(dir);
  expect(shellCwd({ fs: { roots: [path.join(dir, 'missing')] } }, '/proc-cwd')).toBe('/proc-cwd');
  expect(shellCwd({}, '/proc-cwd')).toBe('/proc-cwd');
  expect(shellCwd({ fs: { roots: ['~'] } })).toBe(os.homedir());
});

test('limits come from config.shell, a bad value falls back', () => {
  expect(shellLimits({})).toEqual({ timeoutMs: 120_000, maxChars: 20_000 });
  expect(shellLimits({ shell: { timeoutMs: 5000, maxChars: -1 } })).toEqual({ timeoutMs: 5000, maxChars: 20_000 });
});

test('the display is a console block and one line; the model gets plain text with the output fenced', () => {
  const r = { code: 0, output: 'ok\n', cut: 0, timedOut: false, stopped: false, ms: 1234 };
  const { display, forModel, forTool } = formatShell('echo ok', r, path.join(os.homedir(), 'src/app'));
  expect(display).toBe('```console\n$ echo ok\nok\n```\nexit 0 · 1.2 s · ~/src/app');
  expect(forModel).toBe(`The person ran a shell command in ${path.join(os.homedir(), 'src/app')}:\n$ echo ok\n(exit 0 · 1.2 s)\n\`\`\`\nok\n\`\`\``);
  expect(forTool).toContain('not instructions');
  expect(tildePath('/opt/x')).toBe('/opt/x');
});

test('output carrying a fence of its own cannot close the block', () => {
  const r = { code: 0, output: '```\nnot the end\n', cut: 0, timedOut: false, stopped: false, ms: 5 };
  const { display } = formatShell('cat README.md', r, '/w');
  expect(display.startsWith('````console\n')).toBe(true);
  expect(display).toContain('\n````\n');
});

// ─── the remembered directory ────────────────────────────────────────────────

test('the shell reports where it ended up — apart from the output', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sub'));
  const r = await runShell('cd sub; echo moved', { cwd: dir });
  expect(r.output).toBe('moved\n');
  expect(r.pwd).toBe(path.join(dir, 'sub'));
  // A trailing comment or backslash cannot swallow the report.
  expect((await runShell('cd sub # a comment', { cwd: dir })).pwd).toBe(path.join(dir, 'sub'));
  expect((await runShell('cd sub; echo x \\', { cwd: dir })).pwd).toBe(path.join(dir, 'sub'));
  // The exit code is the command's, not the trailer's.
  expect((await runShell('false', { cwd: dir })).code).toBe(1);
});

test('a command that ends the shell itself, or is killed, leaves no directory', async () => {
  const dir = tmp();
  const r = await runShell('cd /; exit 3', { cwd: dir });
  expect(r.code).toBe(3);
  expect(r.pwd).toBeUndefined();
  expect((await runShell('cd /; sleep 5', { cwd: dir, timeoutMs: 200 })).pwd).toBeUndefined();
});

test('the directory moves only inside the roots, by the real path', () => {
  const root = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(root, 'sub'));
  fs.symlinkSync(outside, path.join(root, 'link'));
  const config = { fs: { roots: [root] } };
  expect(nextCwd(config, root, path.join(root, 'sub'))).toEqual({ cwd: path.join(root, 'sub') });
  expect(nextCwd(config, root, '/')).toEqual({ cwd: root, note: `cd led outside the roots — staying in ${root}` });
  expect(dirAllowed(config, path.join(root, 'link'))).toBe(false);
  expect(nextCwd(config, root, undefined)).toEqual({ cwd: root });
  // No roots configured: any existing directory.
  expect(nextCwd({}, root, '/')).toEqual({ cwd: '/' });
});

test('a conversation keeps its directory; one that has gone reads as the default', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'sub'));
  const config = { fs: { roots: [root] } };
  const a = createShellState(() => config);
  const b = createShellState(() => config);
  expect(a.cwd()).toBe(root);
  a.setCwd(path.join(root, 'sub'));
  expect(a.cwd()).toBe(path.join(root, 'sub'));
  expect(b.cwd()).toBe(root); // not shared between conversations
  fs.rmdirSync(path.join(root, 'sub'));
  expect(a.cwd()).toBe(root);
  expect(createShellState(() => config, '/').cwd()).toBe(root); // outside the roots
});

test('a move is shown on the result line and told to the model', () => {
  const r = { code: 0, output: '', cut: 0, timedOut: false, stopped: false, ms: 10 };
  const moved = formatShell('cd sub', r, '/w', undefined, { after: '/w/sub' });
  expect(moved.display).toContain('/w → /w/sub');
  expect(moved.forModel).toContain('The directory is now /w/sub.');
  expect(moved.forTool).toContain('Directory now: /w/sub');
  const kept = formatShell('cd /', r, '/w', undefined, { after: '/w', note: 'cd led outside the roots — staying in /w' });
  expect(kept.display).toContain('cd led outside the roots');
  expect(kept.forModel).toContain('cd led outside the roots');
});
