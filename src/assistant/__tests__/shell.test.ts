// The runner on real processes: `sh -c` is fast, and only a real process group proves
// that a timeout or an abort ends what the command started, not just the shell.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cdChatTarget, createShellState, dirAllowed, formatShell, legacyRootsNote, nextCwd, runShell, setStartDirForTests, shellCwd, shellLimits, shellRoots, startNote, tildePath } from '../shell.ts';

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

// Rig note: `dir, '/elsewhere'` here are fresh tmp directories, never an ancestor of
// the real `process.cwd()` bun test runs from — so the DEFAULT start (nothing passed)
// reads the real process directory, finds it outside these roots, and still falls
// back to the first one; the assertions below hold either way. Only the `'~'` case
// (home really IS an ancestor of the checkout this runs from) needs an explicit start
// outside it — the rig is adjusted there, not the assertion.
test('with no start given: the real process directory decides, same as an explicit one outside the roots', () => {
  const dir = tmp();
  expect(shellCwd({ fs: { roots: [dir, '/elsewhere'] } })).toBe(dir);
  expect(shellCwd({ fs: { roots: [path.join(dir, 'missing')] } }, '/proc-cwd')).toBe('/proc-cwd');
  expect(shellCwd({}, '/proc-cwd')).toBe('/proc-cwd');
  // Rig: an explicit start outside '~' — the real process directory happens to lie
  // under the home directory this checkout is cloned into, which would otherwise be
  // read as "the start directory is inside the root" and defeat this case.
  expect(shellCwd({ fs: { roots: ['~'] } }, '/proc-cwd')).toBe(os.homedir());
});

// The default: the start directory itself when it lies inside a configured root, or
// when there are no roots at all; otherwise the first root, since the start directory
// is not where the person's work is.
test('the default start directory: inside a root it is kept; outside, the first root; with no roots, always the start', () => {
  const root = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(root, 'sub'));
  expect(shellCwd({ shell: { roots: [root] } }, root)).toBe(root);
  expect(shellCwd({ shell: { roots: [root] } }, path.join(root, 'sub'))).toBe(path.join(root, 'sub'));
  expect(shellCwd({ shell: { roots: [root] } }, outside)).toBe(root);
  // No roots: the start directory itself, whether or not it exists.
  expect(shellCwd({}, outside)).toBe(outside);
  expect(shellCwd({}, '/does/not/exist')).toBe('/does/not/exist');
  // The first root is not a directory: falls back to the start.
  expect(shellCwd({ shell: { roots: [path.join(root, 'missing')] } }, outside)).toBe(outside);
});

test('a symlinked start directory follows the REAL path rule, like everywhere else', () => {
  const root = tmp();
  const outside = tmp();
  fs.symlinkSync(root, path.join(outside, 'into-root'));
  fs.symlinkSync(outside, path.join(root, 'out-link'));
  // A link outside every root that points INTO one is allowed — the real path decides.
  expect(shellCwd({ shell: { roots: [root] } }, path.join(outside, 'into-root'))).toBe(path.join(outside, 'into-root'));
  // A link INSIDE a root that points OUT of it is not — the root is used instead.
  expect(shellCwd({ shell: { roots: [root] } }, path.join(root, 'out-link'))).toBe(root);
});

// The one-line note the chat's start-up says, only when a root took over because the
// start directory was outside every one of them.
test('the start-up note: silent inside a root or with none configured; names both directories otherwise', () => {
  const root = tmp();
  const outside = tmp();
  expect(startNote({ shell: { roots: [root] } }, root)).toBeNull();
  expect(startNote({}, outside)).toBeNull();
  const note = startNote({ shell: { roots: [root] } }, outside);
  expect(note).toContain(tildePath(outside));
  expect(note).toContain(tildePath(root));
});

// The start directory is captured once, not read from `process.cwd()` live at every
// call — the test rig injects it through `setStartDirForTests` (nothing in this
// codebase calls `process.chdir`, so this only matters for tests).
test('the start directory is injectable for tests, and read once by shellCwd/createShellState with no explicit start', () => {
  const root = tmp();
  const outside = tmp();
  setStartDirForTests(outside);
  try {
    expect(shellCwd({ shell: { roots: [root] } })).toBe(root);
    expect(createShellState(() => ({ shell: { roots: [root] } })).cwd()).toBe(root);
    setStartDirForTests(root);
    expect(shellCwd({ shell: { roots: [root] } })).toBe(root);
  } finally { setStartDirForTests(null); }
});

// ─── `/cd` (the person's own, not the model's `cd` tool) ───────────────────────

test('cdChatTarget: held to the roots, by the real path, when any are configured', () => {
  const root = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(root, 'sub'));
  expect(cdChatTarget({ shell: { roots: [root] } }, 'sub', root)).toBe(path.join(root, 'sub'));
  expect(() => cdChatTarget({ shell: { roots: [root] } }, outside, root)).toThrow('outside the configured roots');
  expect(() => cdChatTarget({ shell: { roots: [root] } }, 'nope', root)).toThrow('is not a directory');
});

// A name with a space arrives escaped — typed that way, or Tab-completed to it
// (fieldcomplete.ts's `escapeName`, the same convention `!` shell mode's own
// completion uses) — and must resolve to the real directory, not be refused as
// "not a directory" because the backslash is still in the path `!cd` never sees it:
// a real shell unescapes its own argument, `cdChatTarget` has to do it itself.
test('cdChatTarget unescapes a name with a space, the way completePath spelled it', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a b'));
  expect(cdChatTarget({ shell: { roots: [root] } }, 'a\\ b', root)).toBe(path.join(root, 'a b'));
  // A literal backslash, doubled, still unescapes to one.
  fs.mkdirSync(path.join(root, 'a\\b'));
  expect(cdChatTarget({ shell: { roots: [root] } }, 'a\\\\b', root)).toBe(path.join(root, 'a\\b'));
});

// Unlike the model's `cd` tool (refused with no roots — nobody to confirm it), `/cd`
// is the person's own, so with no roots it follows `!cd`: free to go anywhere.
test('cdChatTarget with no roots configured: free to go anywhere, like !cd', () => {
  const anywhere = tmp();
  expect(cdChatTarget({}, anywhere, tmp())).toBe(anywhere);
});

test('a shell state remembers where it was before the last setCwd, for /cd -', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a'));
  fs.mkdirSync(path.join(root, 'b'));
  const s = createShellState(() => ({ shell: { roots: [root] } }));
  expect(s.previous()).toBeNull(); // nothing yet
  s.setCwd(path.join(root, 'a'));
  expect(s.previous()).toBe(root); // where it was — the default — before this move
  s.setCwd(path.join(root, 'b'));
  expect(s.previous()).toBe(path.join(root, 'a'));
});

test('a shell state keeps the start it was given even if the injected default later changes', () => {
  const root = tmp();
  const outside = tmp();
  const s = createShellState(() => ({ shell: { roots: [root] } }), null, undefined, outside);
  expect(s.start()).toBe(outside);
  expect(s.cwd()).toBe(root); // outside at creation → the first root
  setStartDirForTests(root);
  try {
    expect(s.cwd()).toBe(root); // unchanged — start was captured, not re-read live
  } finally { setStartDirForTests(null); }
});

// `shell.roots` is the shell's own key; `fs.roots` — a host key only the repo plugin
// should own — is read in its place for one release.
test('the roots are shell.roots; fs.roots is read only when shell.roots is not set', () => {
  const a = tmp();
  const b = tmp();
  expect(shellRoots({ shell: { roots: [a] } })).toEqual([a]);
  expect(shellRoots({ shell: { roots: [a] }, fs: { roots: [b] } })).toEqual([a]);
  expect(shellRoots({ fs: { roots: [b] } })).toEqual([b]);
  expect(shellRoots({ shell: { timeoutMs: 5000 }, fs: { roots: [b] } })).toEqual([b]);
  // Set, even empty, is set: an explicit [] leaves the shell unconfined, as fs.roots: [] did.
  expect(shellRoots({ shell: { roots: [] }, fs: { roots: [b] } })).toEqual([]);
  expect(shellRoots({})).toEqual([]);
  expect(shellRoots({ shell: { roots: ['~'] } })).toEqual([os.homedir()]);
});

test('the shell starts in and stays inside shell.roots', () => {
  const root = tmp();
  const other = tmp();
  fs.mkdirSync(path.join(root, 'sub'));
  const config = { shell: { roots: [root] }, fs: { roots: [other] } };
  expect(shellCwd(config, '/proc-cwd')).toBe(root);
  expect(dirAllowed(config, path.join(root, 'sub'))).toBe(true);
  expect(dirAllowed(config, other)).toBe(false);
  expect(nextCwd(config, root, other)).toEqual({ cwd: root, note: `cd led outside the roots — staying in ${root}` });
  expect(createShellState(() => config).cwd()).toBe(root);
});

test('fs.roots in use is noted — where it moved; nothing is said when it is not read', () => {
  const note = legacyRootsNote({ fs: { roots: ['/w'] } });
  expect(note).toContain('fs.roots is read as shell.roots / plugins.repo.roots');
  expect(note).toContain('config set shell.roots');
  expect(legacyRootsNote({})).toBeNull();
  expect(legacyRootsNote({ shell: { roots: ['/w'] } })).toBeNull();
  // shell.roots set: nobody reads fs.roots (repo falls back to shell.roots first).
  expect(legacyRootsNote({ shell: { roots: ['/a'] }, fs: { roots: ['/w'] } })).toBeNull();
});

test('limits come from config.shell, a bad value falls back', () => {
  expect(shellLimits({})).toEqual({ timeoutMs: 120_000, maxChars: 20_000 });
  expect(shellLimits({ shell: { timeoutMs: 5000, maxChars: -1 } })).toEqual({ timeoutMs: 5000, maxChars: 20_000 });
});

test('the display is a console block and one line; the model gets plain text with the output fenced', () => {
  const r = { code: 0, output: 'ok\n', cut: 0, timedOut: false, stopped: false, ms: 1234 };
  const { display, forModel, forTool } = formatShell('echo ok', r, path.join(os.homedir(), 'src/app'));
  expect(display).toBe('```console\n! echo ok\nok\n```\nexit 0 · 1.2 s · ~/src/app');
  expect(forModel).toBe(`The person ran a shell command in ${path.join(os.homedir(), 'src/app')}:\n! echo ok\n(exit 0 · 1.2 s)\n\`\`\`\nok\n\`\`\``);
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

test('output is handed over as it arrives, before the command ends', async () => {
  const seen: string[] = [];
  const r = await runShell('printf a; sleep 0.2; printf b', { cwd: process.cwd(), onOutput: (c) => seen.push(c) });
  expect(seen.join('')).toBe('ab');
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(r.output).toBe('ab');
});

test('stdin, when given, reaches the command byte for byte; without it the command reads nothing', async () => {
  const text = `a b c — ✓\n`;
  const r = await runShell('od -An -tx1 | tr -d " \\n"', { cwd: tmp(), stdin: text });
  expect(r.code).toBe(0);
  expect(r.output.trim()).toBe(Buffer.from(text, 'utf8').toString('hex'));
  const none = await runShell('wc -c', { cwd: tmp() });
  expect(none.output.trim()).toBe('0');
});

test('a command that never reads a large stdin still ends with its own exit code', async () => {
  const r = await runShell('exit 4', { cwd: tmp(), stdin: 'x'.repeat(4 * 1024 * 1024) });
  expect(r.code).toBe(4);
});

test('a known secret never leaves the runner: not in a chunk, not in the output, not past a cut', async () => {
  const { buildSecretSet, setActiveSecrets } = await import('../secrets.ts');
  const token = 'tok-' + 'x'.repeat(40) + '-end';
  setActiveSecrets(buildSecretSet({}, { WIKI_TOKEN: token }));
  try {
    const half = token.length / 2;
    const chunks: string[] = [];
    // Printed in two writes a moment apart, so the pipe hands it over split.
    const cmd = `printf '%s' '${token.slice(0, half)}'; sleep 0.1; printf '%s\\n' '${token.slice(half)} done'`;
    const r = await runShell(cmd, { cwd: tmp(), onOutput: (c) => chunks.push(c) });
    expect(chunks.join('')).toBe('‹secret WIKI_TOKEN› done\n');
    for (const c of chunks) expect(c.includes(token.slice(0, 8)) || c.includes(token.slice(-8))).toBe(false);
    expect(r.output).toBe('‹secret WIKI_TOKEN› done\n');
    // A tail cut through where the token stood keeps none of it.
    const cut = await runShell(`printf '%s' '${token}'; printf 'abcdef'`, { cwd: tmp(), maxChars: 10 });
    expect(cut.output).not.toContain(token.slice(-8));
  } finally {
    setActiveSecrets(null);
  }
});

test('a caller may give the command an environment of its own', async () => {
  const r = await runShell('printf "%s" "${FA_ONLY_HERE-unset}"', { cwd: tmp(), env: { PATH: process.env.PATH, FA_ONLY_HERE: 'yes' } });
  expect(r.output).toBe('yes');
  const plain = await runShell('printf "%s" "${FA_ONLY_HERE-unset}"', { cwd: tmp() });
  expect(plain.output).toBe('unset');
});

test('output cut inside a token, stderr landing inside one, and a coloured one are all still redacted', async () => {
  const { buildSecretSet, setActiveSecrets } = await import('../secrets.ts');
  const token = 'eyJhbGciOiJIUzI1NiJ9.payload-of-a-token.sig';
  process.env.FA_TEST_TOKEN = token;
  setActiveSecrets(buildSecretSet({}, { FA_TEST_TOKEN: token }));
  try {
    // All but the last character, and nothing after it: a held tail at the end.
    const less = await runShell('printf "%s" "${FA_TEST_TOKEN%?}"', { cwd: tmp() });
    expect(less.output).toBe('‹secret FA_TEST_TOKEN›');
    // A stderr write between two halves of a stdout token.
    const split = await runShell(`printf '%s' '${token.slice(0, 20)}'; sleep 0.05; printf X >&2; sleep 0.05; printf '%s\\n' '${token.slice(20)}'`, { cwd: tmp() });
    expect(split.output).not.toContain(token.slice(0, 12));
    expect(split.output).toContain('‹secret FA_TEST_TOKEN›');
    expect(split.output).toContain('X');
    // grep --color paints the match inside the token.
    const painted = await runShell('printf "%s\\n" "$FA_TEST_TOKEN" | grep --color=always payload', { cwd: tmp() });
    expect(painted.output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')).toBe('‹secret FA_TEST_TOKEN›\n');
  } finally {
    delete process.env.FA_TEST_TOKEN;
    setActiveSecrets(null);
  }
});
