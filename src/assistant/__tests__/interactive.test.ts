// The pieces of `!!command` that do not need a terminal: the cleaner that turns a
// recording into text, the `script` invocation per platform, the detection, the
// signal hold, and the runner's temp-file handling with the process injected.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capConsoleData, renderConsole } from '../console-view';
import { cleanRecording, flavorFrom, holdSignals, runInteractive, scriptCommand, type InteractiveSpawn } from '../interactive';

const ESC = '\u001b';

test('cleanRecording takes out colours, cursor sequences and the title, and keeps the text', () => {
  const raw = `${ESC}]0;my title\u0007${ESC}[1;32mok${ESC}[0m done\r\n${ESC}[?25lhidden cursor${ESC}[?25h\r\n`;
  expect(cleanRecording(raw)).toBe('ok done\nhidden cursor');
});

test('cleanRecording leaves a line redrawn with carriage returns in its last state', () => {
  expect(cleanRecording('  0%\r 50%\r100%\r\ndone\r\n')).toBe('100%\ndone');
  // A shorter redraw over a longer line keeps the rest — what a terminal shows.
  expect(cleanRecording('downloading 10%\rdone')).toBe('doneloading 10%');
  // …unless the program erased it, which is what a progress bar does.
  expect(cleanRecording(`downloading 10%\r${ESC}[Kdone`)).toBe('done');
  expect(cleanRecording(`downloading 10%${ESC}[2K\rdone`)).toBe('done');
});

test('cleanRecording moves back on a backspace without erasing, as a terminal does', () => {
  expect(cleanRecording('abc\b\bX')).toBe('aXc');
  // The EOF `script` echoes when its input ends: `^D` then two backspaces, overwritten.
  expect(cleanRecording('^D\b\bhi\r\n')).toBe('hi');
  // A typo fixed at a prompt: `\b \b` erases.
  expect(cleanRecording('name: Rus\b \bslan\r\n')).toBe('name: Ruslan');
});

test('cleanRecording honours a column move and drops control characters and the util-linux header', () => {
  expect(cleanRecording(`abcdef${ESC}[3GX`)).toBe('abXdef');
  expect(cleanRecording('Script started on 2026-09-24 10:00:00+00:00 [TERM="xterm"]\nhello\u0007\nScript done on 2026-09-24 10:00:01+00:00 [COMMAND_EXIT_CODE="0"]\n')).toBe('hello');
  // Trailing blank lines and trailing spaces go; blank lines inside stay.
  expect(cleanRecording('a   \r\n\r\nb\r\n\r\n\r\n')).toBe('a\n\nb');
});

test('scriptCommand: BSD / macOS takes the file, then the command as argv', () => {
  expect(scriptCommand('bsd', 'echo hi', '/tmp/rec')).toEqual({ file: 'script', args: ['-q', '/tmp/rec', '/bin/sh', '-c', 'echo hi'] });
});

test('scriptCommand: util-linux takes the command as one string for -c, and -e for its exit code', () => {
  const c = scriptCommand('util-linux', `echo 'it''s' "x"`, '/tmp/rec');
  expect(c.file).toBe('script');
  expect(c.args.slice(0, 3)).toEqual(['-q', '-e', '-c']);
  expect(c.args.at(-1)).toBe('/tmp/rec');
  // The -c string is run by a shell: it must come back as exactly the command.
  const r = spawnSync('/bin/sh', ['-c', c.args[3]!], { encoding: 'utf8' });
  expect(r.stdout).toBe('its x\n');
  const body = `printf '%s\\n' "a'b"\nexit 4`;
  const r2 = spawnSync('/bin/sh', ['-c', scriptCommand('util-linux', body, '/f').args[3]!], { encoding: 'utf8' });
  expect(r2.stdout).toBe("a'b\n");
  expect(r2.status).toBe(4);
});

test('flavorFrom tells util-linux from BSD by what `script --version` says', () => {
  expect(flavorFrom(false, '')).toBeNull();
  expect(flavorFrom(true, 'script from util-linux 2.39.3')).toBe('util-linux');
  expect(flavorFrom(true, 'script: illegal option -- -\nusage: script [-aeFkpqr] [-t time] [file [command ...]]')).toBe('bsd');
});

test('holdSignals keeps SIGINT and SIGQUIT from the app while the program runs and puts every listener back in order', async () => {
  const target = new EventEmitter();
  const a = () => {}, b = () => {};
  target.on('SIGINT', a);
  target.on('SIGINT', b);
  let during: Function[] = [];
  let quit: Function[] = [];
  const got = await holdSignals(target, async () => {
    during = target.listeners('SIGINT');
    quit = target.listeners('SIGQUIT');
    target.emit('SIGINT'); // heard by the no-op, never by the app's own listeners
    return 7;
  });
  expect(got).toBe(7);
  expect(during).toHaveLength(1);
  expect(during[0]).not.toBe(a);
  expect(quit).toHaveLength(1);
  expect(target.listeners('SIGINT')).toEqual([a, b]);
  expect(target.listeners('SIGQUIT')).toEqual([]);
  // And when the program's run throws.
  await expect(holdSignals(target, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  expect(target.listeners('SIGINT')).toEqual([a, b]);
});

// A fake `script` for the BSD argv: runs the command with a line on its input and
// writes what it printed into the recording file, as the real one would.
const fakeScript = (seen: { dirs: string[] }): InteractiveSpawn => async (file, args, { cwd }) => {
  expect(file).toBe('script');
  const rec = args[1]!;
  seen.dirs.push(path.dirname(rec));
  const r = spawnSync(args[2]!, args.slice(3), { cwd, input: 'Ruslan\n', encoding: 'utf8' });
  fs.writeFileSync(rec, String(r.stdout).replace(/\n/g, '\r\n'));
  return { code: r.status, signal: null };
};

test('runInteractive suspends, records, cleans, caps the tail, reads where a cd led, and removes its temp files', async () => {
  const seen = { dirs: [] as string[] };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-tty-unit-')));
  fs.mkdirSync(path.join(root, 'sub'));
  let suspended = 0;
  const suspend = async <T>(fn: () => T | Promise<T>) => { suspended++; return fn(); };
  const cmd = `printf 'name? '; read n; printf '\\033[32mhello %s\\033[0m\\n' "$n"; printf '10%%\\r99%%\\r'; printf '100%%\\n'; cd sub; (exit 2)`;
  const r = await runInteractive(cmd, { cwd: root, suspend, maxChars: 30 }, { detect: () => 'bsd', spawn: fakeScript(seen), signals: new EventEmitter() });
  expect(suspended).toBe(1);
  expect(r.recorded).toBe(true);
  expect(r.result.code).toBe(2);
  expect(r.result.output).toBe('name? hello Ruslan\n100%');
  expect(r.result.cut).toBe(0);
  expect(r.result.pwd).toBe(path.join(root, 'sub'));
  expect(seen.dirs).toHaveLength(1);
  expect(fs.existsSync(seen.dirs[0]!)).toBe(false);

  const long = await runInteractive(`i=0; while [ $i -lt 20 ]; do echo line$i; i=$((i+1)); done`, { cwd: root, suspend, maxChars: 30 }, { detect: () => 'bsd', spawn: fakeScript(seen), signals: new EventEmitter() });
  expect(long.result.output.length).toBeLessThanOrEqual(30);
  expect(long.result.output.endsWith('line19')).toBe(true);
  expect(long.result.cut).toBeGreaterThan(0);
});

test('runInteractive removes its temp files when the program cannot run, and says what failed', async () => {
  let dir = '';
  const spawn: InteractiveSpawn = async (_file, args) => { dir = path.dirname(args[1]!); throw new Error('spawn exploded'); };
  await expect(runInteractive('true', { cwd: os.tmpdir(), suspend: async (fn) => fn(), maxChars: 100 }, { detect: () => 'bsd', spawn, signals: new EventEmitter() })).rejects.toThrow('spawn exploded');
  expect(dir).not.toBe('');
  expect(fs.existsSync(dir)).toBe(false);

  const failing: InteractiveSpawn = async () => ({ code: null, signal: null, error: 'spawn script ENOENT' });
  const r = await runInteractive('true', { cwd: os.tmpdir(), suspend: async (fn) => fn(), maxChars: 100 }, { detect: () => 'bsd', spawn: failing, signals: new EventEmitter() });
  expect(r.result.error).toBe('spawn script ENOENT');
  expect(r.result.output).toBe('');
});

test('runInteractive without `script` runs the command through the shell with the terminal and records nothing', async () => {
  const calls: { file: string; args: string[] }[] = [];
  const spawn: InteractiveSpawn = async (file, args) => { calls.push({ file, args }); return { code: 0, signal: null }; };
  const r = await runInteractive('vim notes.md', { cwd: os.tmpdir(), suspend: async (fn) => fn(), maxChars: 100 }, { detect: () => null, spawn, signals: new EventEmitter() });
  expect(r.recorded).toBe(false);
  expect(calls[0]!.file).toBe('/bin/sh');
  expect(calls[0]!.args[0]).toBe('-c');
  expect(calls[0]!.args[1]!.startsWith('vim notes.md\n')).toBe(true);
  expect(r.result.output).toBe('');
});

test('runInteractive reports a program killed by a signal as that signal', async () => {
  const spawn: InteractiveSpawn = async (_f, args) => { fs.writeFileSync(args[1]!, 'partial\r\n'); return { code: null, signal: 'SIGKILL' }; };
  const r = await runInteractive('top', { cwd: os.tmpdir(), suspend: async (fn) => fn(), maxChars: 100 }, { detect: () => 'bsd', spawn, signals: new EventEmitter() });
  expect(r.result.code).toBeNull();
  expect(r.result.signal).toBe('SIGKILL');
  expect(r.result.output).toBe('partial');
});

test('the console view keeps the interactive mark through the cap (a live update, a session reload) and draws it beside the command', () => {
  const d = capConsoleData({ command: 'git add -p', cwd: '~/a', text: 'x', exitCode: 0, ms: 1200, interactive: true });
  expect(d.interactive).toBe(true);
  expect(capConsoleData({ command: 'ls', cwd: '~', text: '' }).interactive).toBeUndefined();
  const ctx = { width: 80, folded: true, live: false, failed: false, elapsedMs: 0, lines: 20, moreKey: '^o' };
  const folded = renderConsole(d, ctx).map((l) => l.map((s) => s.text).join(''));
  expect(folded).toEqual(['git add -p · interactive · ✓ 1.2 s']);
  const open = renderConsole(d, { ...ctx, folded: false }).map((l) => l.map((s) => s.text).join(''));
  expect(open[0]).toBe('git add -p · interactive');
});
