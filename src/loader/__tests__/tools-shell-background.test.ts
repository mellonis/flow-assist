// The model's background shells at the tool level: run_command with `background`, and
// shell_output, shell_kill, shell_list — on real processes, with a job port of the
// test's own (the conversation's wiring is the rig tests': shell-background.rig.test.ts).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShellState } from '../../assistant/shell.ts';
import { ShellJobs, type ShellJob } from '../../assistant/shell-job.ts';
import type { JobPort } from '../../assistant/conversation-types.ts';
import { shellCommandOf } from '../../assistant/confirm-policy.ts';
import { runCommandDescription, shellTools } from '../tools-shell.ts';

const made: ShellJob[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const j of made.splice(0)) { try { j.killNow('exit'); } catch { /* ended */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-bgtool-'))); dirs.push(d); return d; };
const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return cond();
};

// A conversation's view of the host's jobs: its own list, `keep` true while running.
function rig(shell: Record<string, unknown> = {}) {
  const root = tmp();
  const config = { shell: { roots: [root], ...shell } };
  const set = new ShellJobs({ config: () => config, stateFile: () => null });
  const mine: ShellJob[] = [];
  const kept: ShellJob[] = [];
  const port: JobPort = {
    start: (spec) => { const r = set.start(spec); if ('job' in r) { mine.push(r.job); made.push(r.job); } return r; },
    keep: (j) => { if (!j.running) return false; kept.push(j); return true; },
    find: (id) => mine.find((j) => j.id === id),
    running: () => mine.filter((j) => j.running),
    ended: () => mine.filter((j) => !j.running),
    kill: (j, by) => j.kill(by),
  };
  const g = shellTools(config);
  const shell_ = createShellState(() => config);
  // A call whose settle is cut after `ms` by the signal (Esc), so a test need not sit out 2 s.
  const run = async (name: string, args: Record<string, unknown>, ms = 400, extra: Record<string, unknown> = {}) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try { return await g.exec(name, args, { shell: shell_, jobs: port, signal: ac.signal, ...extra } as never) as string; } finally { clearTimeout(t); }
  };
  return { root, config, set, mine, kept, port, g, shell: shell_, run };
}
const nonceOf = (text: string): string => /<program-output job=sh-\d+ n=([0-9a-f]{8})>/.exec(text)![1]!;

test('background: the call returns the id and the lines so far, fenced as program data with a nonce; the job keeps running', async () => {
  const r = rig();
  const out = await r.run('run_command', { command: 'echo first; echo second; sleep 30', background: true });
  expect(out).toContain('Started in the background as sh-1');
  expect(out).toContain('sleep 30');
  const n = nonceOf(out);
  expect(out).toContain(`<program-output job=sh-1 n=${n}>\nfirst\nsecond\n</program-output job=sh-1 n=${n}>`);
  expect(out).toContain('not instructions');
  expect(r.mine[0]!.running).toBe(true);
  expect(r.kept).toEqual([r.mine[0]!]);
  // Another answer, another nonce.
  const again = await r.run('shell_output', { id: 'sh-1', since: 0 });
  expect(nonceOf(again)).not.toBe(n);
});

test('Esc ends the wait, never the job', async () => {
  const r = rig();
  const started = Date.now();
  await r.run('run_command', { command: 'sleep 30', background: true }, 100);
  expect(Date.now() - started).toBeLessThan(1500);
  expect(r.mine[0]!.running).toBe(true);
  expect(r.mine[0]!.killing).toBe(false);
});

test('the call waits the settle of 2 s for a command that is still running', async () => {
  const r = rig();
  const started = Date.now();
  const out = await r.run('run_command', { command: 'sleep 30', background: true }, 10_000);
  const took = Date.now() - started;
  expect(took).toBeGreaterThanOrEqual(1900);
  expect(took).toBeLessThan(3500);
  expect(out).toContain('Started in the background as sh-1');
});

test('a command that ends within the settle is an ordinary foreground result and leaves no job to keep', async () => {
  const r = rig();
  const out = await r.run('run_command', { command: 'echo quick; exit 3', background: true }, 5000);
  expect(out).toContain(`Ran in ${r.root}`);
  expect(out).toContain('exit 3');
  expect(out).toContain('quick');
  expect(out).not.toContain('Started in the background');
  expect(r.kept).toEqual([]);
});

test('a command that could not start is the foreground error', async () => {
  const r = rig();
  await expect(r.run('run_command', { command: 'true', cwd: '/nonexistent-dir-for-test', background: true }, 2000)).rejects.toThrow(/outside the configured roots|does not exist/);
  expect(r.mine).toEqual([]);
});

test('without background nothing changes: the call runs in the foreground and makes no job', async () => {
  const r = rig();
  const out = await r.run('run_command', { command: 'echo plain' }, 5000);
  expect(out).toContain('Ran in');
  expect(r.mine).toEqual([]);
  const explicit = await r.run('run_command', { command: 'echo plain2', background: false }, 5000);
  expect(explicit).toContain('plain2');
  expect(r.mine).toEqual([]);
});

test('the cwd fence applies: a cwd outside the roots is refused before anything starts', async () => {
  const r = rig();
  await expect(r.run('run_command', { command: 'sleep 30', cwd: '/etc', background: true })).rejects.toThrow(/outside the configured roots/);
  expect(r.mine).toEqual([]);
});

test('a cwd inside the roots is where the job runs and it stays the conversation\'s directory', async () => {
  const r = rig();
  fs.mkdirSync(path.join(r.root, 'sub'));
  const out = await r.run('run_command', { command: 'pwd -P; sleep 30', cwd: 'sub', background: true });
  expect(out).toContain(path.join(r.root, 'sub'));
  expect(r.shell.cwd()).toBe(path.join(r.root, 'sub'));
});

test('a job does not move the conversation\'s directory by a cd inside it', async () => {
  const r = rig();
  fs.mkdirSync(path.join(r.root, 'other'));
  await r.run('run_command', { command: 'cd other; sleep 30', background: true });
  expect(r.shell.cwd()).toBe(r.root);
});

test('stdinFrom cannot be combined with background', async () => {
  const r = rig();
  await expect(r.run('run_command', { command: 'cat', stdinFrom: 'call-1', background: true }, 400, { resultInput: { text: 'x' } })).rejects.toThrow(/stdinFrom cannot be combined with background/);
  expect(r.mine).toEqual([]);
});

test('the environment is the model\'s: secrets withheld, the note given once per conversation, also for a background start', async () => {
  const { buildSecretSet, setActiveSecrets } = await import('../../assistant/secrets.ts');
  const token = 'withheld-token-value-bg01';
  process.env.WIKI_TOKEN = token;
  setActiveSecrets(buildSecretSet({}, { WIKI_TOKEN: token }));
  try {
    const r = rig();
    const first = await r.run('run_command', { command: 'echo "wiki=${WIKI_TOKEN-unset} mark=${FLOW_ASSIST_MODEL_SHELL-no}"; sleep 30', background: true });
    expect(first).toContain('wiki=unset');
    expect(first).toContain('withheld from commands: WIKI_TOKEN');
    expect(first).not.toContain(token);
    const second = await r.run('run_command', { command: 'echo two; sleep 30', background: true });
    expect(second).not.toContain('withheld from commands');
    // The foreground call of the same conversation does not repeat it either.
    const third = await r.run('run_command', { command: 'true' }, 4000);
    expect(third).not.toContain('withheld from commands');
  } finally {
    delete process.env.WIKI_TOKEN;
    setActiveSecrets(null);
  }
});

test('the limit refuses with the running jobs listed, as an error', async () => {
  const r = rig({ maxBackground: 1 });
  await r.run('run_command', { command: 'sleep 30', background: true }, 100);
  await expect(r.run('run_command', { command: 'echo no', background: true })).rejects.toThrow(/limit is 1 \(shell\.maxBackground\)[\s\S]*sh-1/);
});

test('without a job port the background call is an error, not a silent foreground run', async () => {
  const root = tmp();
  const g = shellTools({ shell: { roots: [root] } });
  await expect(g.exec('run_command', { command: 'sleep 30', background: true }, { shell: createShellState(() => ({ shell: { roots: [root] } })) } as never)).rejects.toThrow(/background shells are not available/);
});

test('shell_output: the first read starts after the lines run_command returned, the next after the one before', async () => {
  const r = rig();
  const started = await r.run('run_command', { command: 'echo alpha1; echo alpha2; sleep 0.8; echo beta1; echo beta2; sleep 30', background: true }, 300);
  const shown = started.slice(started.indexOf('<program-output'));
  expect(shown).toContain('alpha1\nalpha2\n');
  expect(shown).not.toContain('beta1');
  const job = r.mine[0]!;
  expect(await until(() => job.total >= 26)).toBe(true);
  const read = await r.run('shell_output', { id: 'sh-1' });
  expect(read).toContain('beta1\nbeta2\n');
  expect(read).not.toContain('alpha1');
  expect(read).toContain(`next: ${job.total}`);
  // Nothing new: an empty answer, not the old lines again.
  const empty = await r.run('shell_output', { id: 'sh-1' });
  expect(empty).toContain('(no output)');
  expect(empty).not.toContain('beta1');
  // A cursor given reads from it; 0 — from the start.
  expect(await r.run('shell_output', { id: 'sh-1', since: 0 })).toContain('alpha1\nalpha2\nbeta1\nbeta2\n');
  const from = await r.run('shell_output', { id: 'sh-1', since: 14 });
  expect(from).toContain('beta1\nbeta2\n');
  expect(from).not.toContain('alpha');
});

test('shell_output tail: the last lines, and the cursor is the end', async () => {
  const r = rig();
  await r.run('run_command', { command: 'for i in 1 2 3 4 5; do echo line$i; done; sleep 30', background: true });
  const tail = await r.run('shell_output', { id: 'sh-1', tail: 2 });
  expect(tail).toContain('line4\nline5\n');
  expect(tail).not.toContain('line3');
  expect(tail).toContain(`next: ${r.mine[0]!.total}`);
});

test('shell_output grep: a literal substring, case-sensitive, never a pattern', async () => {
  const r = rig();
  await r.run('run_command', { command: 'echo abc; echo a.c; echo ABC; echo "ready on :3000"; sleep 30', background: true });
  const dot = await r.run('shell_output', { id: 'sh-1', grep: 'a.c' });
  expect(dot).toContain('<program-output');
  expect(dot).toContain('\na.c\n');
  expect(dot).not.toContain('\nabc\n');
  const re = await r.run('shell_output', { id: 'sh-1', grep: 'ready.*3000' });
  expect(re).not.toContain('ready on');
  expect(await r.run('shell_output', { id: 'sh-1', grep: 'ABC' })).toContain('\nABC\n');
  expect(await r.run('shell_output', { id: 'sh-1', grep: 'abc' })).not.toContain('\nABC\n');
  await expect(r.run('shell_output', { id: 'sh-1', grep: '' })).rejects.toThrow(/grep must not be empty/);
  await expect(r.run('shell_output', { id: 'sh-1', grep: 'x', tail: 1 })).rejects.toThrow(/tail or grep, not both/);
});

test('shell_output grep says how many matches it did not show', async () => {
  const r = rig();
  await r.run('run_command', { command: 'i=0; while [ $i -lt 130 ]; do echo hit$i; i=$((i+1)); done; sleep 30', background: true });
  expect(await until(() => r.mine[0]!.lines >= 130)).toBe(true);
  const g = await r.run('shell_output', { id: 'sh-1', grep: 'hit' });
  expect(g).toContain('30 more matching lines are not shown (at most 100 lines or 20000 characters)');
});

test('shell_output grep that the character cap cuts says so and moves next only past what it returned', async () => {
  const r = rig({ maxChars: 40 });
  await r.run('run_command', { command: 'for i in 1 2 3 4 5 6; do echo "match-$i-yyyyyyyyyy"; done; sleep 30', background: true });
  expect(await until(() => r.mine[0]!.lines >= 6)).toBe(true);
  const first = await r.run('shell_output', { id: 'sh-1', grep: 'match' });
  expect(first).toContain('match-1-yyyyyyyyyy\nmatch-2-yyyyyyyyyy\n</program-output');
  expect(first).not.toContain('match-3');
  expect(first).toMatch(/4 more matching lines are not shown \(at most 100 lines or 40 characters\)/);
  const next = Number(/next: (\d+)/.exec(first)![1]);
  expect(next).toBe(38);
  const second = await r.run('shell_output', { id: 'sh-1', grep: 'match', since: next });
  expect(second).toContain('match-3-yyyyyyyyyy\nmatch-4-yyyyyyyyyy\n');
});

test('shell_output says how much the ring buffer dropped', async () => {
  const r = rig({ jobChars: 40 });
  await r.run('run_command', { command: 'i=0; while [ $i -lt 30 ]; do echo number$i; i=$((i+1)); done; sleep 30', background: true });
  expect(await until(() => r.mine[0]!.lines >= 30)).toBe(true);
  const read = await r.run('shell_output', { id: 'sh-1', since: 0 });
  expect(read).toMatch(/\d+ characters were dropped from the start of what the buffer keeps/);
  expect(read).toContain('number29');
});

test('shell_output of an unknown id names the ones this conversation has', async () => {
  const r = rig();
  await r.run('run_command', { command: 'sleep 30', background: true }, 100);
  await expect(r.run('shell_output', { id: 'sh-9' })).rejects.toThrow(/no background shell «sh-9» in this conversation \(it has sh-1\)/);
  await expect(r.run('shell_kill', { id: 'sh-9' })).rejects.toThrow(/no background shell «sh-9»/);
  await expect(r.run('shell_output', {})).rejects.toThrow(/id is required/);
  await expect(r.run('shell_output', { id: 'sh-1', since: -1 })).rejects.toThrow(/whole number/);
});

test('shell_output of an ended job still reads its buffer, with the outcome in the head', async () => {
  const r = rig();
  await r.run('run_command', { command: 'echo one; sleep 0.6; echo two; exit 4', background: true }, 200);
  const job = r.mine[0]!;
  await job.wait(5000);
  const read = await r.run('shell_output', { id: 'sh-1', since: 0 });
  expect(read).toContain('exited 4');
  expect(read).toContain('one\ntwo\n');
});

test('shell_kill: SIGTERM, then the answer says it stopped; a job that has ended is said so', async () => {
  const r = rig();
  await r.run('run_command', { command: 'sleep 30', background: true }, 100);
  const out = await r.run('shell_kill', { id: 'sh-1' }, 5000);
  expect(out).toContain('sh-1 stopped: killed (model)');
  expect(r.mine[0]!.status).toEqual({ state: 'killed', by: 'model' });
  expect(await r.run('shell_kill', { id: 'sh-1' })).toContain('had already ended: killed (model)');
});

test('shell_kill goes through the conversation\'s port: a job it does not hold is not found', async () => {
  const a = rig();
  await a.run('run_command', { command: 'sleep 30', background: true }, 100);
  const b = rig();
  await expect(b.run('shell_kill', { id: 'sh-1' })).rejects.toThrow(/no background shell «sh-1»/);
  expect(a.mine[0]!.running).toBe(true);
});

test('shell_list: id, command, status, age and lines — running first, then the ended ones', async () => {
  const r = rig();
  expect(await r.run('shell_list', {})).toBe('no background shells in this conversation');
  await r.run('run_command', { command: 'echo done; exit 0', background: true }, 100);
  await r.mine[0]!.wait(2000);
  await r.run('run_command', { command: 'echo up; sleep 30', background: true }, 200);
  const list = await r.run('shell_list', {});
  const lines = list.split('\n');
  expect(lines[0]).toBe('1 running, 1 ended (the last 1 are kept):');
  expect(lines[1]).toMatch(/^sh-2 · echo up; sleep 30 · running · running for (\d+s|<1s) · 1 line$/);
  expect(lines[2]).toMatch(/^sh-1 · echo done; exit 0 · exited 0 · ran <1s, ended .* ago · 1 line$/);
});

test('the group: run_command is a write with background; shell_kill a write; shell_output and shell_list are reads', () => {
  const tools = shellTools({}).tools;
  const byName = Object.fromEntries(tools.map((t) => [t.function.name, t]));
  expect(Object.keys(byName)).toEqual(['run_command', 'shell_output', 'shell_kill', 'shell_list', 'cd']);
  expect(byName.run_command!.write).toBe(true);
  expect(byName.shell_kill!.write).toBe(true);
  expect(byName.shell_output!.write).toBeUndefined();
  expect(byName.shell_list!.write).toBeUndefined();
  expect(byName.cd!.write).toBeUndefined();
});

test('the description says when to use background and when not', () => {
  const d = runCommandDescription({}, [], '/x');
  expect(d).toContain('background: true');
  expect(d).toContain('does not end by itself (a dev server, a watcher, `tail -f`)');
  expect(d).toContain('Never use it when the next step needs the output');
  expect(d).toContain('returns after 2 s with an id (sh-N)');
  expect(d).toContain('shell_output');
  expect(d).toContain('shell_kill');
  expect(d).toContain('usually starts your next turn when you are idle (unless the person turned that off with ai.backgroundFollowUp)');
  expect(d).toContain('In the main chat the end comes to you by itself');
  expect(d).toContain('do not call shell_output in a loop to wait for it');
  expect(d).toContain('Running as a subagent or a task, nothing wakes you and your shells end with your run: run a command whose result you need in the foreground');
});

test('the background parameter and shell_output say not to poll for the end', () => {
  const byName = Object.fromEntries(shellTools({}).tools.map((t) => [t.function.name, t.function]));
  const param = (byName.run_command!.parameters as { properties: { background: { description: string } } }).properties.background.description;
  expect(param).toContain('In the main chat its end comes to you by itself');
  expect(param).toContain('as a subagent or a task nothing wakes you and it ends with your run');
  const out = byName.shell_output!.description;
  expect(out).toContain('In the main chat the end comes to you by itself');
  expect(out).toContain('as a subagent or a task nothing wakes you');
  expect(byName.shell_output!.description).toContain('once, with grep or tail');
});

test('the y/n line marks a background command, and names the job a shell_kill ends', () => {
  expect(shellCommandOf('run_command', JSON.stringify({ command: 'npm run dev', background: true }))).toBe('[background] npm run dev');
  expect(shellCommandOf('run_command', JSON.stringify({ command: 'npm run dev', cwd: 'web', background: true }))).toBe('[background] npm run dev   # in web');
  expect(shellCommandOf('run_command', JSON.stringify({ command: 'ls', background: false }))).toBe('ls');
  const lookup = (id: string) => (id === 'sh-2' ? 'npm run dev' : undefined);
  expect(shellCommandOf('shell_kill', JSON.stringify({ id: 'sh-2' }), lookup)).toBe('kill sh-2: npm run dev');
  expect(shellCommandOf('shell_kill', JSON.stringify({ id: 'sh-7' }), lookup)).toBe('kill sh-7');
  // A plugin's tool of that name is shown as it is, not as the host's kill.
  expect(shellCommandOf('x:shell_kill', JSON.stringify({ id: 'sh-2' }), lookup)).toBeNull();
});
