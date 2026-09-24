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
import { withPwdTrailer } from '../shell';
import { sessionTitle } from '../sessions';
import { cleanRecording, flavorFrom, holdSignals, readTail, runInteractive, scriptCommand, type InteractiveSpawn } from '../interactive';

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

test('cleanRecording drops what a full-screen program drew on the alternate screen, as a terminal does once it leaves', () => {
  expect(cleanRecording(`before\r\n${ESC}[?1049h${ESC}[2J${ESC}[1;1H~ vim junk ~\r\n~${ESC}[?1049lafter\r\n`)).toBe('before\nafter');
  expect(cleanRecording(`a\r\n${ESC}[?47hless page${ESC}[?47lb`)).toBe('a\nb');
});

test('string sequences are dropped whole — an OSC title, a sixel (DCS), kitty graphics (APC), a PM — terminated or not', () => {
  expect(cleanRecording(`a${ESC}]0;title${ESC}\\b`)).toBe('ab');
  expect(cleanRecording(`a${ESC}Pq#0;2;0;0;0#0~~@@vv${ESC}\\b`)).toBe('ab');
  expect(cleanRecording(`a${ESC}_Gf=100,a=T;iVBORw0KGgo=${ESC}\\b`)).toBe('ab');
  expect(cleanRecording(`a${ESC}^private${ESC}\\b`)).toBe('ab');
  // Unterminated: runs to the next ESC (or a bounded length), never into the text after it.
  expect(cleanRecording(`a${ESC}]0;half a title${ESC}[31mred`)).toBe('ared');
});

test('a hostile recording is cleaned in linear time: 20k unterminated OSCs in 1 MiB, a huge column move', () => {
  const junk = `${ESC}]` + 'x'.repeat(50);
  const raw = junk.repeat(20_000).slice(0, 1024 * 1024);
  const t0 = performance.now();
  cleanRecording(raw);
  expect(performance.now() - t0).toBeLessThan(1000);
  const t1 = performance.now();
  const moved = cleanRecording(`a${ESC}[999999999Cb${ESC}[999999999Gc`);
  expect(performance.now() - t1).toBeLessThan(200);
  expect(moved.length).toBeLessThanOrEqual(4097);
  expect(moved.startsWith('a')).toBe(true);
});

test('a tail that begins inside the alternate screen keeps only what came after it left', () => {
  expect(cleanRecording(`junk\r\n~ redraw ~${ESC}[?1049lafter\r\n`)).toBe('after');
  // An exit that follows an enter is the ordinary case: what came before stays.
  expect(cleanRecording(`before\r\n${ESC}[?1049hjunk${ESC}[?1049lafter`)).toBe('before\nafter');
});

test('readTail reads the END of a big recording, from a whole line, and says how much it skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-tail-'));
  const file = path.join(dir, 'rec');
  const line = 'x'.repeat(99) + '\n';
  fs.writeFileSync(file, line.repeat(30_000) + 'the end\n'); // ~3 MB
  const { text, skipped } = readTail(file, 1000);
  expect(text.endsWith('the end\n')).toBe(true);
  expect(text.startsWith('x')).toBe(true);
  expect(text.split('\n')[0]).toHaveLength(99); // a whole line, never half of one
  expect(skipped + Buffer.byteLength(text)).toBe(fs.statSync(file).size);
  expect(readTail(file).text.length).toBeLessThanOrEqual(1024 * 1024);
  fs.writeFileSync(file, 'small\n');
  expect(readTail(file)).toEqual({ text: 'small\n', skipped: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scriptCommand: BSD / macOS takes the recording file, then the shell and the command FILE as argv', () => {
  expect(scriptCommand('bsd', '/tmp/fa-tty-x/cmd', '/tmp/rec')).toEqual({ file: 'script', args: ['-q', '/tmp/rec', '/bin/sh', '/tmp/fa-tty-x/cmd'] });
});

test('scriptCommand: util-linux gets `/bin/sh <file>` for -c, and -e for its exit code; a path no shell reads plainly is refused', () => {
  const c = scriptCommand('util-linux', '/tmp/fa-tty-x/cmd', '/tmp/rec');
  expect(c).toEqual({ file: 'script', args: ['-q', '-e', '-c', "/bin/sh '/tmp/fa-tty-x/cmd'", '/tmp/rec'] });
  expect(() => scriptCommand('util-linux', "/tmp/it's/cmd", '/r')).toThrow('cannot be handed to script');
  expect(() => scriptCommand('bsd', '/tmp/a\nb/cmd', '/r')).toThrow('cannot be handed to script');
});

// Every shell a person may have as $SHELL — util-linux's `script -c` runs its string
// with it — must run the command file exactly as written.
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/csh', '/bin/tcsh', '/opt/homebrew/bin/fish', '/usr/bin/fish', '/usr/local/bin/fish'].filter((s) => fs.existsSync(s));

test('a nasty command reaches the shell exactly as typed, whatever $SHELL re-parses the -c string', async () => {
  const nasty = `printf '%s|' "a'b" 'c"d' \`echo tick\` "$HOME_NOPE" 'back\\slash' "two\\\\"; printf '\\n'\necho "line two" && echo '$x'`;
  let content = '';
  let dir = '';
  const spawn: InteractiveSpawn = async (_f, args) => {
    const cmdFile = args[3]!;
    dir = path.dirname(cmdFile);
    content = fs.readFileSync(cmdFile, 'utf8');
    return { code: 0, signal: null };
  };
  await runInteractive(nasty, { cwd: os.tmpdir(), suspend: async (fn) => fn(), maxChars: 100 }, { detect: () => 'bsd', spawn, signals: new EventEmitter() });
  expect(content).toBe(withPwdTrailer(nasty, path.join(dir, 'pwd')));
  // And the util-linux -c string, run by each shell there is, runs that file.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-tty-sh-')));
  const file = path.join(tmp, 'cmd');
  fs.writeFileSync(file, nasty);
  const expected = spawnSync('/bin/sh', [file], { encoding: 'utf8' }).stdout;
  expect(expected).toContain("a'b|");
  const c = scriptCommand('util-linux', file, '/r');
  for (const sh of SHELLS) {
    const r = spawnSync(sh, ['-c', c.args[3]!], { encoding: 'utf8', env: { ...process.env, HOME: tmp } });
    expect([sh, r.stdout]).toEqual([sh, expected]);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('flavorFrom tells util-linux from BSD, each by a positive sign, and uses neither otherwise', () => {
  expect(flavorFrom(false, '')).toBeNull();
  expect(flavorFrom(true, 'script from util-linux 2.39.3', 'Linux')).toBe('util-linux');
  expect(flavorFrom(true, 'script: illegal option -- -\nusage: script [-aeFkpqr] [-t time] [file [command ...]]', 'Linux')).toBe('bsd');
  expect(flavorFrom(true, 'script: unknown option', 'FreeBSD')).toBe('bsd');
  expect(flavorFrom(true, '', 'Darwin')).toBe('bsd');
  // Some other `script` on some other system: not used — the program runs unrecorded.
  expect(flavorFrom(true, 'script 1.0 (busybox)', 'Linux')).toBeNull();
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

test('the signals are held around the whole hand-over — SIGCONT too — and given back only after the terminal is back', async () => {
  const target = new EventEmitter();
  const app = () => {};
  for (const sig of ['SIGINT', 'SIGCONT']) target.on(sig, app);
  const events: string[] = [];
  const count = () => `${target.listeners('SIGINT').includes(app)}/${target.listeners('SIGCONT').includes(app)}`;
  const suspend = async <T>(fn: () => T | Promise<T>) => {
    events.push(`leave ${count()}`);
    try { return await fn(); } finally { events.push(`back ${count()}`); }
  };
  const spawn: InteractiveSpawn = async () => { events.push(`run ${count()}`); return { code: 0, signal: null }; };
  await runInteractive('true', { cwd: os.tmpdir(), suspend, maxChars: 100 }, { detect: () => null, spawn, signals: target });
  // The app's listeners are off before the terminal is handed over, and still off
  // when it comes back; they return afterwards.
  expect(events).toEqual(['leave false/false', 'run false/false', 'back false/false']);
  expect(target.listeners('SIGINT')).toEqual([app]);
  expect(target.listeners('SIGCONT')).toEqual([app]);
  expect(target.listeners('SIGQUIT')).toEqual([]);
});

// A fake `script` for the BSD argv: runs the command with a line on its input and
// writes what it printed into the recording file, as the real one would.
const fakeScript = (seen: { dirs: string[] }): InteractiveSpawn => async (file, args, { cwd }) => {
  expect(args.slice(2)).toEqual(['/bin/sh', path.join(path.dirname(args[1]!), 'cmd')]);
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
  expect(calls[0]!.args).toHaveLength(1);
  expect(path.basename(calls[0]!.args[0]!)).toBe('cmd');
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

test('a session is never named by the host\'s ask after a !!command', () => {
  const ask = { role: 'user', content: 'Look at what the interactive command above printed…', hostAsk: true };
  expect(sessionTitle([{ role: 'shell', command: 'git add -p', content: '' }, ask])).toBe('$ git add -p');
  expect(sessionTitle([{ role: 'shell', command: 'top', content: '' }, ask, { role: 'user', content: 'why so slow?' }])).toBe('why so slow?');
});
