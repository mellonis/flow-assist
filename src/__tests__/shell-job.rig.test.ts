// A conversation's background shells (AGENTS.md, "A host makes its conversations through
// one registry"): what the journal says, who counts them, and every way they end — on real
// processes, because only a real process group shows that a kill reached everything the
// command started.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostStateDir } from '../config/load.ts';
import type { Conversation } from '../assistant/conversation.ts';
import { exportMarkdown } from '../assistant/journal.ts';
import type { ShellJob } from '../assistant/shell-job.ts';
import { ScriptedModel } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';
import { homeIn } from './helpers/session-files';

const strays: number[] = [];
const dirs: string[] = [];
afterEach(() => {
  closeRigs();
  for (const p of strays.splice(0)) { try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const groupAlive = (pid: number): boolean => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return cond();
};
const gone = (pid: number, ms = 1500) => until(() => !groupAlive(pid), ms);
const lockOf = (rig: Rig, id: string) => path.join(homeIn(rig.sessionsDir!, id), `${id}.lock`);
const rigWith = (shell: Record<string, unknown> = {}) => conversationRig(new ScriptedModel(), { shell });

// Starts a job in `c` and waits until its group exists, so a kill that follows reaches it.
async function start(c: Conversation, command: string, by: 'model' | 'person' = 'person'): Promise<ShellJob> {
  const r = c.startJob({ command, cwd: c.shell.cwd(), by });
  if (!('job' in r)) throw new Error(r.refused);
  strays.push(r.job.pid!);
  expect(await until(() => groupAlive(r.job.pid!))).toBe(true);
  return r.job;
}
const jobEvents = (rig: Rig, c: Conversation, t: string) => rig.journal(c.sessionId).filter((e) => e.t === t);

test('the journal gets job-start, the output coalesced by id, and job-end with the exit code; /export stitches them', async () => {
  const rig = rigWith();
  const c = rig.conv;
  const j = await start(c, 'echo one; sleep 0.05; echo two; exit 3');
  await j.wait(3000);
  await rig.until(() => jobEvents(rig, c, 'job-end').length === 1);
  const events = rig.journal(c.sessionId);
  expect(events.find((e) => e.t === 'job-start')).toMatchObject({ id: 'sh-1', command: 'echo one; sleep 0.05; echo two; exit 3', by: 'person' });
  expect((events.find((e) => e.t === 'job-start') as { cwd: string }).cwd).toContain(path.basename(rig.root));
  // Two prints a moment apart are one journal line, as `shell-out` coalesces them.
  const outs = jobEvents(rig, c, 'job-out');
  expect(outs).toHaveLength(1);
  expect(outs[0]).toMatchObject({ id: 'sh-1', text: 'one\ntwo\n' });
  expect(events.find((e) => e.t === 'job-end')).toMatchObject({ id: 'sh-1', code: 3, by: 'self' });
  const md = exportMarkdown(events, { title: '', id: c.sessionId });
  expect(md).toContain('background sh-1, started by you');
  expect(md).toContain('```console\none\ntwo\n```');
  expect(md).toContain('*exit 3 ·');
});

test('a job started by the model is journaled by: model', async () => {
  const rig = rigWith();
  const c = rig.conv;
  c.ensureSessionId();
  const j = await start(c, 'true', 'model');
  await j.wait(3000);
  await rig.until(() => jobEvents(rig, c, 'job-end').length === 1);
  expect(jobEvents(rig, c, 'job-start')[0]).toMatchObject({ by: 'model' });
});

test('a job that is killed says by whom in its end line', async () => {
  const rig = rigWith();
  const c = rig.conv;
  const j = await start(c, 'sleep 30');
  j.kill('model');
  await j.wait(3000);
  await rig.until(() => jobEvents(rig, c, 'job-end').length === 1);
  expect(jobEvents(rig, c, 'job-end')[0]).toMatchObject({ id: 'sh-1', killed: true, by: 'model' });
  expect(jobEvents(rig, c, 'job-end')[0]).not.toHaveProperty('code');
  expect(exportMarkdown(rig.journal(c.sessionId), { title: '', id: c.sessionId })).toContain('*killed (model) ·');
});

test('a running job is held beside the children; an ended one keeps its record and buffer, the last twenty', async () => {
  const rig = rigWith({ maxBackground: 1 });
  const c = rig.conv;
  expect([...c.children]).toEqual([]);
  const first = await start(c, 'echo kept; sleep 30');
  expect(c.jobs.get('sh-1')).toBe(first);
  expect(c.jobById('sh-1')).toBe(first);
  expect(c.children.size).toBe(0);
  await rig.until(() => first.total > 0);
  first.kill('person');
  await first.wait(3000);
  expect(c.jobs.size).toBe(0);
  expect(c.endedShellJobs).toEqual([first]);
  expect(c.jobById('sh-1')!.read().text).toBe('kept\n');
  for (let i = 0; i < 24; i++) { const j = await start(c, 'true'); await j.wait(3000); }
  expect(c.endedShellJobs).toHaveLength(20);
  expect(c.endedShellJobs[0]!.id).toBe('sh-6');
  expect(c.endedShellJobs.at(-1)!.id).toBe('sh-25');
  expect(c.jobById('sh-1')).toBeUndefined();
  expect(c.jobById('sh-25')!.statusText).toBe('exited 0');
});

test('one limit for the whole process: a start is refused with the running jobs listed, from any conversation', async () => {
  const rig = rigWith({ maxBackground: 2 });
  const a = rig.conv;
  await start(a, 'sleep 30');
  const b = rig.fresh();
  await start(b, 'sleep 31');
  const refused = a.startJob({ command: 'echo fifth', cwd: a.shell.cwd(), by: 'model' });
  expect(refused).toHaveProperty('refused');
  const text = (refused as { refused: string }).refused;
  expect(text).toContain('sh-1');
  expect(text).toContain('sleep 31');
  expect(text).toContain('(shell.maxBackground)');
  expect(a.jobs.size).toBe(1);
  expect(rig.registry.jobs.list().map((j) => j.id)).toEqual(['sh-1', 'sh-2']);
});

test('a conversation with a running job is not quiescent, and a session left with one stays loaded, working, until it ends', async () => {
  const rig = rigWith();
  const a = rig.conv;
  rig.registry.show(a);
  const j = await start(a, 'sleep 30');
  expect(rig.registry.quiescent(a)).toBe(false);
  a.detach(rig.port);
  expect(rig.switchTo()).toMatchObject({ left: a, outcome: 'kept' });
  expect(rig.registry.statusOf(a.sessionId)).toBe('working');
  expect(a.closed).toBe(false);
  expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(true);
  j.kill('person');
  await j.wait(3000);
  await rig.until(() => a.closed);
  expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(false);
});

test('/clear (the conversation\'s close) ends its jobs with SIGTERM, writes the end line, and forgets the ended ones', async () => {
  const rig = rigWith();
  const c = rig.conv;
  const done = await start(c, 'true');
  await done.wait(3000);
  const j = await start(c, 'sleep 30');
  expect(c.endedShellJobs).toHaveLength(1);
  const t0 = Date.now();
  c.close('clear');
  expect(j.killing).toBe(true);
  expect(await gone(j.pid!)).toBe(true);
  expect(Date.now() - t0).toBeLessThan(1500);
  await j.wait(3000);
  await rig.until(() => jobEvents(rig, c, 'job-end').some((e) => e.id === 'sh-2'));
  expect(jobEvents(rig, c, 'job-end').find((e) => e.id === 'sh-2')).toMatchObject({ killed: true, by: 'clear' });
  expect(c.endedShellJobs).toEqual([]);
  expect(c.jobs.size).toBe(0);
});

test('a program that ignores SIGTERM is killed two seconds after the close', async () => {
  const rig = rigWith();
  const c = rig.conv;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-job-pid-'));
  dirs.push(dir);
  const pidFile = path.join(dir, 'pid');
  const j = await start(c, `trap '' TERM; echo $$ > '${pidFile}'; echo ready; sleep 30`);
  await rig.until(() => j.total > 0);
  c.close('clear');
  await new Promise((r) => setTimeout(r, 500));
  expect(groupAlive(j.pid!)).toBe(true);
  expect(await gone(j.pid!, 3500)).toBe(true);
});

test('a job a closed conversation was still ending does not count against the limit, and /clear then a new start works at once', async () => {
  const rig = rigWith({ maxBackground: 1 });
  const c = rig.conv;
  const j = await start(c, `trap '' TERM; echo ready; sleep 30`);
  await rig.until(() => j.total > 0);
  c.close('clear');
  expect(j.killing).toBe(true);
  const next = rig.fresh();
  const r = next.startJob({ command: 'true', cwd: next.shell.cwd(), by: 'person' });
  expect(r).toHaveProperty('job');
});

test('the conversation\'s close at exit kills its group at once, with no grace period', async () => {
  const rig = rigWith();
  const c = rig.conv;
  const j = await start(c, `trap '' TERM; echo ready; sleep 30`);
  await rig.until(() => j.total > 0);
  c.close('exit');
  expect(j.running).toBe(false);
  expect(j.status).toEqual({ state: 'killed', by: 'exit' });
  expect(await gone(j.pid!)).toBe(true);
});

test('the exit of the host: the end line is written before the group dies, the sessions are unlocked, and the group is gone', async () => {
  const rig = rigWith();
  const a = rig.conv;
  rig.registry.show(a);
  a.ensureSessionId();
  const j = await start(a, 'echo up; sleep 30');
  await rig.until(() => j.total > 0);
  const alive: boolean[] = [];
  j.onEnd(() => alive.push(groupAlive(j.pid!)));
  a.detach(rig.port);
  const b = rig.fresh();
  rig.registry.show(b);
  expect(rig.registry.retire(a)).toBe('kept');
  const c = rig.fresh();
  rig.registry.show(c);
  b.ensureSessionId();
  b.save();
  rig.registry.closeAll('exit');
  // Synchronous: the end line is in the journal now, and it was written with the group alive.
  expect(alive).toEqual([true]);
  expect(jobEvents(rig, a, 'job-end')).toMatchObject([{ id: 'sh-1', killed: true, by: 'exit' }]);
  expect(await gone(j.pid!)).toBe(true);
  for (const conv of [a, b]) expect(fs.existsSync(lockOf(rig, conv.sessionId))).toBe(false);
  expect(exportMarkdown(rig.journal(a.sessionId), { title: '', id: a.sessionId })).toContain('*killed (exit) ·');
});

test('the exit of the host reaches a job whose conversation was already closed and whose group is still in its SIGTERM grace', async () => {
  const rig = rigWith();
  const c = rig.conv;
  const j = await start(c, `trap '' TERM; echo ready; sleep 30`);
  await rig.until(() => j.total > 0);
  c.close('clear');
  expect(groupAlive(j.pid!)).toBe(true);
  rig.registry.closeAll('exit');
  // It was ended by the clear; the exit only does not wait out the grace.
  expect(j.status).toEqual({ state: 'killed', by: 'clear' });
  expect(await gone(j.pid!, 1500)).toBe(true);
});

// A subagent the person started, as `startChild` makes one.
function subagent(rig: Rig): Conversation {
  const started = rig.conv.startChild({ kind: 'subagent', label: 'sub', prompt: 'p', by: 'person' }, rig.conv.ensureSessionId());
  if (!('child' in started)) throw new Error(started.refused);
  return started.child;
}

test('a subagent may start a job; stopping the subagent kills it, by: person', async () => {
  const rig = rigWith();
  const sub = subagent(rig);
  const j = await start(sub, 'sleep 30', 'model');
  expect(sub.jobs.size).toBe(1);
  expect(rig.conv.hasWorkingChildren).toBe(true);
  expect(sub.stopSubtree('x')).toBe(true);
  expect(j.killing).toBe(true);
  expect(await gone(j.pid!)).toBe(true);
  await j.wait(3000);
  expect(j.status).toEqual({ state: 'killed', by: 'person' });
});

test('clearing the session kills a subagent\'s job too (by: clear)', async () => {
  const rig = rigWith();
  const sub = subagent(rig);
  const j = await start(sub, 'sleep 30', 'model');
  rig.conv.close('clear');
  expect(await gone(j.pid!)).toBe(true);
  await j.wait(3000);
  expect(j.status).toEqual({ state: 'killed', by: 'clear' });
});

test('a subagent that ends on its own kills the jobs it left running (by: parent); nothing is handed to its parent', async () => {
  const rig = rigWith();
  const sub = subagent(rig);
  const j = await start(sub, 'sleep 30', 'model');
  sub.close('park');
  expect(j.killing).toBe(true);
  expect(rig.conv.jobs.size).toBe(0);
  expect(await gone(j.pid!)).toBe(true);
  await j.wait(3000);
  expect(j.status).toEqual({ state: 'killed', by: 'parent' });
});

test('a subagent\'s job-end lands in its file before the file\'s closing end line, for a stop and for the exit', async () => {
  const order = (rig: Rig) => rig.subJournal('sub').map((e) => e.t).filter((t) => t === 'job-end' || t === 'end');
  const stopRig = rigWith();
  const sub = subagent(stopRig);
  await start(sub, 'sleep 30', 'model');
  sub.stopSubtree('x');
  await stopRig.until(() => order(stopRig).includes('job-end'));
  expect(order(stopRig)).toEqual(['job-end', 'end']);
  closeRigs();

  const exitRig = rigWith();
  const sub2 = subagent(exitRig);
  await start(sub2, 'sleep 30', 'model');
  exitRig.registry.closeAll('exit');
  expect(order(exitRig)).toEqual(['job-end', 'end']);
});

test('at exit the jobs are ended before any session lock is released', async () => {
  const rig = rigWith();
  const a = rig.conv;
  a.ensureSessionId();
  const j = await start(a, 'sleep 30');
  const seen: string[] = [];
  j.onEnd(() => seen.push('job end'));
  const release = a.releaseLock.bind(a);
  a.releaseLock = () => { seen.push('release'); release(); };
  rig.registry.closeAll('exit');
  expect(seen).toEqual(['job end', 'release']);
});

test('without a host that keeps jobs, a start is refused rather than thrown', () => {
  const rig = rigWith();
  const c = rig.conv;
  const bare = Object.create(c, { deps: { value: { ...c.deps, jobs: undefined } } }) as Conversation;
  expect(bare.startJob({ command: 'true', cwd: '/', by: 'model' })).toEqual({ refused: 'background shells are not available here' });
});

test('a rig lists no job in the shared state directory', async () => {
  const rig = rigWith();
  await start(rig.conv, 'sleep 30');
  expect(fs.existsSync(path.join(hostStateDir(), 'shell-jobs.json'))).toBe(false);
});
