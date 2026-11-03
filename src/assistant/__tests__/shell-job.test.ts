// A background shell on real processes: only a real process group proves that a kill
// reaches what the command started, and only a real pipe that a program left running
// keeps a job alive after its shell has gone.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GREP_LINES, JOB_DEFAULTS, ShellJob, ShellJobs, jobLimits } from '../shell-job.ts';

const dirs: string[] = [];
const jobsMade: ShellJob[] = [];
const strays: number[] = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-job-'))); dirs.push(d); return d; };
afterEach(() => {
  for (const j of jobsMade.splice(0)) { try { j.killNow('exit'); } catch { /* ended */ } }
  for (const p of strays.splice(0)) { try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const groupAlive = (pid: number): boolean => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return cond();
};
const gone = (pid: number, ms = 4000) => until(() => !groupAlive(pid), ms);
const readPid = (file: string): number | null => {
  try { const n = Number(fs.readFileSync(file, 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; }
};

function jobs(shell: Record<string, unknown> = {}, stateFile: string | null = null) {
  const set = new ShellJobs({ config: () => ({ shell }), stateFile: () => stateFile });
  const start = (command: string, by: 'model' | 'person' = 'model') => {
    const r = set.start({ command, cwd: tmp(), by });
    if ('job' in r) jobsMade.push(r.job);
    return r;
  };
  const job = (command: string, by: 'model' | 'person' = 'model'): ShellJob => {
    const r = start(command, by);
    if (!('job' in r)) throw new Error(r.refused);
    return r.job;
  };
  return { set, start, job };
}

test('limits: the defaults, and a bad value falls back to them', () => {
  expect(jobLimits(undefined)).toEqual({ maxBackground: 4, jobChars: 64_000 });
  expect(JOB_DEFAULTS).toEqual({ maxBackground: 4, jobChars: 64_000 });
  expect(jobLimits({ shell: { maxBackground: 2, jobChars: 500 } })).toEqual({ maxBackground: 2, jobChars: 500 });
  expect(jobLimits({ shell: { maxBackground: 0, jobChars: 'x' } })).toEqual({ maxBackground: 4, jobChars: 64_000 });
});

test('a job runs on its own: ids count up, it exits with its code, and stdout and stderr are kept in order', async () => {
  const { job } = jobs();
  const a = job('echo one; sleep 0.05; echo two >&2; sleep 0.05; echo three; exit 3');
  const b = job('true');
  expect([a.id, b.id]).toEqual(['sh-1', 'sh-2']);
  expect(a.running).toBe(true);
  expect(await a.wait(3000)).toBe(true);
  expect(a.status).toEqual({ state: 'exited', code: 3 });
  expect(a.statusText).toBe('exited 3');
  expect(a.read().text).toBe('one\ntwo\nthree\n');
  expect(a.lines).toBe(3);
  expect(a.endedAt).not.toBeNull();
});

test('its stdin is closed: a program that reads it sees the end at once', async () => {
  const j = jobs().job('cat; echo after');
  expect(await j.wait(3000)).toBe(true);
  expect(j.read().text).toBe('after\n');
});

test('the ring buffer keeps the last jobChars; a cursor behind it says how many were dropped', async () => {
  const j = jobs({ jobChars: 100 }).job(`head -c 300 /dev/zero | tr '\\0' a; echo; echo THE END`);
  await j.wait(3000);
  expect(j.total).toBe(300 + 1 + 8);
  const all = j.read(0);
  expect(all.text.length).toBe(100);
  expect(all.text.endsWith('THE END\n')).toBe(true);
  expect(all.dropped).toBe(309 - 100);
  expect(all.from).toBe(209);
  expect(all.next).toBe(309);
  // A cursor inside the buffer loses nothing; one at the end reads nothing; one past it too.
  expect(j.read(300)).toMatchObject({ text: '\nTHE END\n', dropped: 0, from: 300, next: 309 });
  expect(j.read(309)).toMatchObject({ text: '', dropped: 0, next: 309 });
  expect(j.read(9999)).toMatchObject({ text: '', next: 309 });
  // A cursor handed back by the last read reads only what came since.
  expect(j.read(all.next).text).toBe('');
  expect(j.read(0, 10).text).toHaveLength(10);
  expect(j.droppedChars).toBe(209);
});

test('a reader\'s cursor sees only what is new, while the job prints on', async () => {
  const j = jobs().job('echo first; sleep 0.3; echo second');
  await until(() => j.total > 0);
  const r1 = j.read(0);
  expect(r1.text).toBe('first\n');
  await j.wait(3000);
  const r2 = j.read(r1.next);
  expect(r2).toMatchObject({ text: 'second\n', dropped: 0 });
});

test('tail gives the last lines and grep a literal, never a pattern', async () => {
  const j = jobs().job(`printf 'abc\\na.c\\nzzz\\nlast\\n'`);
  await j.wait(3000);
  expect(j.tail(2).text).toBe('zzz\nlast\n');
  expect(j.tail(99).text).toBe('abc\na.c\nzzz\nlast\n');
  expect(j.grep('a.c').lines).toEqual(['a.c']);
  expect(j.grep('').lines).toEqual([]);
  expect(j.grep('last', 0).next).toBe(j.total);
  expect(j.grep('abc', 5).lines).toEqual([]);
});

test('kill is SIGTERM to the group first: a program that ends on it ends at once, as killed', async () => {
  const j = jobs().job('sleep 30');
  const pid = j.pid!;
  const t0 = Date.now();
  expect(j.kill('person')).toBe(true);
  expect(j.killing).toBe(true);
  expect(j.kill('person')).toBe(false);
  expect(await j.wait(1500)).toBe(true);
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(j.status).toEqual({ state: 'killed', by: 'person' });
  expect(j.statusText).toBe('killed (person)');
  expect(await gone(pid)).toBe(true);
});

test('a program that ignores SIGTERM is sent SIGKILL after two seconds', async () => {
  const dir = tmp();
  const pidFile = path.join(dir, 'pid');
  const j = jobs().job(`trap '' TERM; echo $$ > '${pidFile}'; sleep 30`);
  await until(() => readPid(pidFile) !== null);
  j.kill('model');
  await new Promise((r) => setTimeout(r, 600));
  expect(j.running).toBe(true);
  expect(groupAlive(j.pid!)).toBe(true);
  expect(await j.wait(4000)).toBe(true);
  expect(j.status).toEqual({ state: 'killed', by: 'model' });
  expect(await gone(j.pid!)).toBe(true);
});

test('a program the job left running with & does not end the job, nor get killed 200 ms after the shell: only the job\'s kill ends the group', async () => {
  const dir = tmp();
  const pidFile = path.join(dir, 'pid');
  const j = jobs().job(`sleep 30 & echo $! > '${pidFile}'`);
  await until(() => readPid(pidFile) !== null);
  const sleeper = readPid(pidFile)!;
  await new Promise((r) => setTimeout(r, 700));
  expect(j.running).toBe(true);
  expect(groupAlive(j.pid!)).toBe(true);
  expect(() => process.kill(sleeper, 0)).not.toThrow();
  j.kill('person');
  expect(await j.wait(4000)).toBe(true);
  expect(await gone(j.pid!)).toBe(true);
});

// What `process.kill` is asked to do and the job's end announcement, in the order they
// happen: a signal is delivered asynchronously, so only the order of the two calls shows
// that the end was announced first.
function orderOfKillAndEnd<T>(job: ShellJob[], run: () => T): { order: string[]; result: T } {
  const order: string[] = [];
  const real = process.kill;
  for (const j of job) j.onEnd(() => order.push(`end ${j.id}`));
  process.kill = ((pid: number, sig?: string | number) => { if (pid < 0 && sig === 'SIGKILL') order.push(`SIGKILL ${-pid}`); return real.call(process, pid, sig as never); }) as typeof process.kill;
  try { return { order, result: run() }; } finally { process.kill = real; }
}

test('killNow announces the end first and only then kills the group, all in one synchronous step', async () => {
  const j = jobs().job('sleep 30');
  const pid = j.pid!;
  expect(await until(() => groupAlive(pid))).toBe(true);
  const { order } = orderOfKillAndEnd([j], () => j.killNow('exit'));
  expect(order).toEqual(['end sh-1', `SIGKILL ${pid}`]);
  expect(j.running).toBe(false);
  expect(await gone(pid)).toBe(true);
  // Ending twice changes nothing.
  j.killNow('person');
  expect(j.status).toEqual({ state: 'killed', by: 'exit' });
});

test('onEnd on an ended job is called at once; wait times out without ending the job, and an abort ends the wait only', async () => {
  const { job } = jobs();
  const done = job('true');
  await done.wait(3000);
  let called = 0;
  done.onEnd(() => { called++; });
  expect(called).toBe(1);
  const slow = job('sleep 30');
  expect(await slow.wait(100)).toBe(false);
  const ac = new AbortController();
  const waiting = slow.wait(10_000, ac.signal);
  ac.abort();
  expect(await waiting).toBe(false);
  expect(slow.running).toBe(true);
});

test('a shell that cannot start ends as exited with its error, not as a throw', async () => {
  const set = new ShellJobs({ config: () => ({}), stateFile: () => null });
  const r = set.start({ command: 'true', cwd: path.join(tmp(), 'missing'), by: 'model' });
  if (!('job' in r)) throw new Error('refused');
  jobsMade.push(r.job);
  expect(await r.job.wait(3000)).toBe(true);
  expect(r.job.status).toEqual({ state: 'exited', code: 127 });
  expect(r.job.error).toBeTruthy();
});

test('a secret never reaches the buffer or a listener', async () => {
  const { buildSecretSet, setActiveSecrets } = await import('../secrets.ts');
  const token = 'tok-' + 'x'.repeat(40) + '-end';
  setActiveSecrets(buildSecretSet({}, { WIKI_TOKEN: token }));
  try {
    const j = jobs().job(`printf '%s' '${token.slice(0, 20)}'; sleep 0.1; printf '%s\\n' '${token.slice(20)} done'`);
    const chunks: string[] = [];
    j.onOutput((c) => chunks.push(c));
    await j.wait(3000);
    expect(j.read().text).toBe('‹secret WIKI_TOKEN› done\n');
    expect(chunks.join('')).toBe('‹secret WIKI_TOKEN› done\n');
  } finally {
    setActiveSecrets(null);
  }
});

test('the limit: a fifth start is refused with the running jobs listed; a job being killed does not count; a lowered limit ends nothing', async () => {
  const { set, start, job } = jobs({ maxBackground: 2 });
  const a = job('sleep 30');
  const b = job('sleep 30');
  const refused = start('echo no');
  expect(refused).toHaveProperty('refused');
  const text = (refused as { refused: string }).refused;
  expect(text).toContain('shell.maxBackground');
  expect(text).toContain('sh-1');
  expect(text).toContain('sh-2');
  expect(text).toContain('sleep 30');
  expect(set.list()).toEqual([a, b]);
  expect(set.get('sh-2')).toBe(b);
  // Nothing was spent on the refusal: the next id is the third.
  a.kill('person');
  const c = job('sleep 30');
  expect(c.id).toBe('sh-3');
  await a.wait(3000);
  expect(set.list()).toEqual([b, c]);
});

test('the default limit is four', () => {
  const { job, start } = jobs();
  for (let i = 0; i < 4; i++) job('sleep 30');
  expect(start('true')).toHaveProperty('refused');
});

test('killAll ends every job at once, each announced before its group is sent SIGKILL', async () => {
  const { set, job } = jobs();
  const a = job('sleep 30');
  const b = job('sleep 30');
  const pids = [a.pid!, b.pid!];
  for (const p of pids) expect(await until(() => groupAlive(p))).toBe(true);
  const { order } = orderOfKillAndEnd([a, b], () => set.killAll('exit'));
  expect(order).toEqual(['end sh-1', `SIGKILL ${pids[0]}`, 'end sh-2', `SIGKILL ${pids[1]}`]);
  expect(set.list()).toEqual([]);
  for (const p of pids) expect(await gone(p)).toBe(true);
});

test('the state file lists the running jobs and is rewritten as they start and end', async () => {
  const file = path.join(tmp(), 'state', 'shell-jobs.json');
  const { job } = jobs({}, file);
  const a = job('sleep 30');
  const listed = () => (JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs: { id: string; pgid: number; startedAt: number; command: string; owner: number }[] }).jobs;
  expect(listed()).toEqual([{ owner: process.pid, id: 'sh-1', pgid: a.pid!, startedAt: a.startedAt, command: 'sleep 30' }]);
  const b = job('sleep 31');
  expect(listed().map((e) => e.id)).toEqual(['sh-1', 'sh-2']);
  a.kill('person');
  await a.wait(3000);
  expect(listed().map((e) => e.id)).toEqual(['sh-2']);
  b.kill('person');
  await b.wait(3000);
  expect(fs.existsSync(file)).toBe(false);
});

// A process that has ended, for a pid that no longer exists; and one that lives on in a
// group of its own, as a job a crashed run left.
async function deadPid(): Promise<number> {
  const p = spawn('true');
  await new Promise((r) => p.on('close', r));
  return p.pid!;
}
function orphan(): number {
  const p = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
  p.unref();
  strays.push(p.pid!);
  return p.pid!;
}

test('at start, jobs a dead run left alive are named once with their pids and are not killed', async () => {
  const file = path.join(tmp(), 'shell-jobs.json');
  const left = orphan();
  const dead = await deadPid();
  const entry = (id: string, pgid: number, owner: number, command: string) => ({ owner, id, pgid, startedAt: 1_700_000_000_000, command });
  fs.writeFileSync(file, JSON.stringify({ jobs: [entry('sh-1', left, dead, 'npm run dev'), entry('sh-2', dead, dead, 'gone already')] }));
  const { set } = jobs({}, file);
  const found = set.scanLeftovers();
  expect(found.map((l) => l.pgid)).toEqual([left]);
  const note = set.leftoverNote()!;
  expect(note).toContain(`pid ${left}`);
  expect(note).toContain('npm run dev');
  expect(note).not.toContain('gone already');
  expect(note).toContain('does not stop');
  // Reported, not touched: the group still runs, and the file no longer lists either entry.
  expect(groupAlive(left)).toBe(true);
  expect(fs.existsSync(file)).toBe(false);
  expect(jobs({}, file).set.scanLeftovers()).toEqual([]);
});

test('an entry of a run that is still alive is neither reported nor dropped, and our own writes keep it', async () => {
  const file = path.join(tmp(), 'shell-jobs.json');
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  strays.push(other.pid!);
  const theirs = { owner: other.pid!, id: 'sh-1', pgid: orphan(), startedAt: 1, command: 'their server' };
  fs.writeFileSync(file, JSON.stringify({ jobs: [theirs] }));
  const { set, job } = jobs({}, file);
  expect(set.scanLeftovers()).toEqual([]);
  expect(set.leftoverNote()).toBeNull();
  const mine = job('sleep 30');
  const listed = (JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs: { id: string; owner: number }[] }).jobs;
  expect(listed.map((e) => [e.owner, e.id])).toEqual([[other.pid!, 'sh-1'], [process.pid, 'sh-1']]);
  mine.killNow('exit');
  expect((JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs: unknown[] }).jobs).toHaveLength(1);
  other.kill();
});

test('no state file configured: nothing is written and nothing is read', () => {
  const { set, job } = jobs({}, null);
  job('true');
  expect(set.scanLeftovers()).toEqual([]);
});

// A job made directly, with a short grace period before SIGKILL.
function direct(command: string, graceMs = 100, chars = 1000): ShellJob {
  const j = new ShellJob('sh-x', { command, cwd: tmp(), by: 'model' }, chars, graceMs);
  jobsMade.push(j);
  return j;
}

test('tail(0) and a negative count give nothing; an empty buffer gives nothing', async () => {
  const j = jobs().job(`printf 'a\\nb\\nc\\n'`);
  await j.wait(3000);
  expect(j.tail(0).text).toBe('');
  expect(j.tail(-3).text).toBe('');
  expect(j.tail(1).text).toBe('c\n');
  const empty = jobs().job('true');
  await empty.wait(3000);
  expect(empty.tail(5).text).toBe('');
});

test('grep returns at most GREP_LINES matches and says how many more; its cursor continues after the last one returned', async () => {
  const j = jobs().job(`i=0; while [ $i -lt 130 ]; do echo "hit $i"; i=$((i+1)); done; echo miss`);
  await j.wait(3000);
  const first = j.grep('hit');
  expect(first.lines).toHaveLength(GREP_LINES);
  expect(first.lines[0]).toBe('hit 0');
  expect(first.more).toBe(30);
  const rest = j.grep('hit', first.next);
  expect(rest.lines[0]).toBe('hit 100');
  expect(rest.lines).toHaveLength(30);
  expect(rest.more).toBe(0);
});

test('grep\'s cursor never consumes a line still being written, so a match split across two reads is found', async () => {
  const j = jobs().job(`printf 'abc ne'; sleep 0.4; printf 'edle\\nx\\n'`);
  await until(() => j.total > 0);
  const early = j.grep('needle');
  expect(early.lines).toEqual([]);
  expect(early.next).toBe(0);
  await j.wait(3000);
  expect(j.grep('needle', early.next).lines).toEqual(['abc needle']);
});

test('after a drop, grep skips the fragment the buffer starts in', async () => {
  const j = jobs({ jobChars: 20 }).job(`printf 'aaaaaaaaaaaaaaaaaaaaneedle one\\nneedle two\\n'`);
  await j.wait(3000);
  const r = j.grep('one');
  expect(r.dropped).toBeGreaterThan(0);
  expect(j.read().text).toContain('one');
  expect(r.lines).toEqual([]);
});

test('a cursor at the buffer\'s start, inside a line the ring buffer cut, still skips that fragment; with no newline in the buffer nothing is returned and the drop is told once', async () => {
  const j = jobs({ jobChars: 20 }).job(`printf 'aaaaaaaaaaaaaaaaaaaaneedle one\nneedle two\n'`);
  await j.wait(3000);
  expect(j.read().text).toContain('one');
  // The cursor is exactly where the buffer starts: no drop under it, and the first line is a fragment.
  const at = j.grep('one', j.droppedChars);
  expect(at.dropped).toBe(0);
  expect(at.lines).toEqual([]);
  const two = j.grep('needle', j.droppedChars);
  expect(two.lines).toEqual(['needle two']);

  const running = jobs({ jobChars: 20 }).job(`printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; sleep 30`);
  expect(await until(() => running.total >= 40)).toBe(true);
  const first = running.grep('b');
  expect(first.lines).toEqual([]);
  expect(first.dropped).toBe(20);
  expect(first.next).toBe(20);
  const again = running.grep('b', first.next);
  expect(again.lines).toEqual([]);
  expect(again.dropped).toBe(0);
  expect(again.next).toBe(20);
  running.killNow('exit');
});

test('a ring buffer cut exactly at a line start loses no line to grep', async () => {
  const j = jobs({ jobChars: 8 }).job(`printf 'xxxxxxxx\nneedle1\n'`);
  await j.wait(3000);
  const r = j.grep('needle');
  expect(r.dropped).toBeGreaterThan(0);
  expect(r.lines).toEqual(['needle1']);
});

test('grep with a character cap returns the first matches that fit, leaves the rest to the next read, and its cursor stops before the first one left', async () => {
  const j = jobs().job(`for i in 1 2 3 4 5; do echo "hit-$i-xxxxxxxx"; done`);
  await j.wait(3000);
  // Each match is 14 characters and a newline: two fit in 30.
  const first = j.grep('hit', 0, 30);
  expect(first.lines).toEqual(['hit-1-xxxxxxxx', 'hit-2-xxxxxxxx']);
  expect(first.more).toBe(3);
  expect(first.next).toBe(30);
  const rest = j.grep('hit', first.next, 30);
  expect(rest.lines).toEqual(['hit-3-xxxxxxxx', 'hit-4-xxxxxxxx']);
  expect(j.grep('hit', rest.next, 30).lines).toEqual(['hit-5-xxxxxxxx']);
  // The first match always comes, however long.
  expect(j.grep('hit', 0, 3).lines).toEqual(['hit-1-xxxxxxxx']);
});

test('a kill always ends the job: a process that left the group and holds the pipes does not keep it alive', async () => {
  const dir = tmp();
  const pidFile = path.join(dir, 'pid');
  const j = direct(`perl -MPOSIX -e 'POSIX::setsid(); sleep 30' & echo $! > '${pidFile}'; echo ready; sleep 30`);
  await until(() => readPid(pidFile) !== null && j.total > 0);
  const daemon = readPid(pidFile)!;
  // Held back until it has left the group (its group id is its own).
  const pgidOf = () => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(daemon)], { encoding: 'utf8' }).trim());
  expect(await until(() => { try { return pgidOf() === daemon; } catch { return false; } })).toBe(true);
  try {
    j.kill('person');
    expect(await j.wait(3000)).toBe(true);
    expect(j.status).toEqual({ state: 'killed', by: 'person' });
  } finally {
    try { process.kill(daemon, 'SIGKILL'); } catch { /* gone */ }
  }
});

test('the SIGKILL timer is cleared when the job ends first: no signal reaches the group later', async () => {
  const j = direct('sleep 30', 150);
  await until(() => groupAlive(j.pid!));
  j.kill('person');
  await j.wait(3000);
  const calls: string[] = [];
  const real = process.kill;
  process.kill = ((pid: number, sig?: string | number) => { calls.push(`${pid}:${String(sig)}`); return real.call(process, pid, sig as never); }) as typeof process.kill;
  try { await new Promise((r) => setTimeout(r, 400)); } finally { process.kill = real; }
  expect(calls).toEqual([]);
});

// `process.kill` made to fail for a group, as it does just after a spawn: the calls to a
// single pid are recorded and let through.
function withoutGroup<T>(run: (single: string[]) => T): T {
  const single: string[] = [];
  const real = process.kill;
  process.kill = ((pid: number, sig?: string | number) => {
    if (pid < 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    single.push(`${pid}:${String(sig)}`);
    return real.call(process, pid, sig as never);
  }) as typeof process.kill;
  try { return run(single); } finally { process.kill = real; }
}

test('when the group is not there yet, the unreaped shell itself is signalled', async () => {
  const j = direct('sleep 30');
  const single = withoutGroup((calls) => { j.kill('person'); return calls; });
  expect(single).toEqual([`${j.pid}:SIGTERM`]);
  expect(await j.wait(3000)).toBe(true);
});

test('once the shell is reaped, its pid is not signalled: it may belong to someone else by now', async () => {
  const j = direct('true');
  await j.wait(3000);
  const single = withoutGroup((calls) => { (j as unknown as { signalGroup(s: string): void }).signalGroup('SIGKILL'); return calls; });
  expect(single).toEqual([]);
});

test('an ended job holds no output listeners', async () => {
  const j = jobs().job('echo hi');
  j.onOutput(() => {});
  await j.wait(3000);
  expect((j as unknown as { outputs: Set<unknown> }).outputs.size).toBe(0);
});

test('a job that ends on its own with a program of its group still alive (stdio redirected) ends that group, and says so', async () => {
  const { job } = jobs();
  const j = job('sleep 37 >/dev/null 2>&1 & echo started');
  await j.wait(5000);
  expect(j.status).toEqual({ state: 'exited', code: 0 });
  expect(j.leftover).toBe(true);
  expect(await gone(j.pid!)).toBe(true);
});

test('a job whose whole group ended with it is not marked leftover', async () => {
  const { job } = jobs();
  const j = job('echo plain');
  await j.wait(5000);
  expect(j.leftover).toBe(false);
});

test('a leftover that ignores SIGTERM is sent SIGKILL after the grace', async () => {
  const set = new ShellJobs({ config: () => ({ shell: {} }), stateFile: () => null });
  const r = set.start({ command: "(trap '' TERM; sleep 37) >/dev/null 2>&1 & sleep 0.3", cwd: tmp(), by: 'model' });
  if (!('job' in r)) throw new Error(r.refused);
  jobsMade.push(r.job);
  await r.job.wait(5000);
  expect(r.job.leftover).toBe(true);
  expect(await gone(r.job.pid!, 6000)).toBe(true);
});
