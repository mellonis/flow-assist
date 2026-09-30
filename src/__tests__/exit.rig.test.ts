// At exit every live conversation is saved and unlocked, each task still counted says in
// its session's journal that it stopped, and everything closes, deepest first
// (AGENTS.md (a host makes its conversations through one registry)).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Conversation } from '../assistant/conversation.ts';
import type { Make } from '../loader/plugin.ts';
import { exportMarkdown } from '../assistant/journal.ts';
import { ScriptedModel, type RecordedRequest } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';
import { homeIn } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; closeRigs(); });

const WORKER = 'You are a background worker';
const system = (req: RecordedRequest): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
const taskScript = (model: ScriptedModel, task: string) => model.when((req) => system(req).includes(WORKER) && system(req).includes(`Task: ${task}`));
const lockOf = (rig: Rig, id: string) => path.join(homeIn(rig.sessionsDir!, id), `${id}.lock`);
const taskEnds = (rig: Rig, c: Conversation) => rig.journal(c.sessionId).filter((e) => e.t === 'task-end');
const bgSaved = (rig: Rig, c: Conversation) => (rig.sessionFile(c.sessionId)?.messages ?? [])
  .filter((m) => (m as { role?: string }).role === 'bg');

// Session A starts a task held until the test releases it, and the chat leaves A for B:
// A stays loaded, locked and headless while the task runs.
async function headlessWithTask() {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'find it', label: 'find' } }], [{ text: 'Started.' }]);
  const task = taskScript(model, 'find it');
  task.script([{ hold: true }, { text: 'found it' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const a = rig.conv;
  rig.registry.show(a);
  await a.send('find it in the background');
  await rig.until(() => task.held && a.title !== '');
  a.detach(rig.port);
  const b = rig.fresh();
  rig.registry.show(b);
  expect(rig.registry.retire(a)).toBe('kept');
  expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(true);
  return { rig, a, task };
}

test('at exit a headless session with a running task is saved and unlocked, and its journal says the task stopped', async () => {
  const { rig, a, task } = await headlessWithTask();
  const [child] = [...a.children];
  rig.registry.closeAll('exit');
  expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(false);
  expect(rig.sessionFile(a.sessionId)?.messages.some((m) => (m as { content?: unknown }).content === 'find it in the background')).toBe(true);
  expect(taskEnds(rig, a)).toMatchObject([{ t: 'task-end', task: 'find', outcome: 'stopped', by: 'exit' }]);
  expect(exportMarkdown(rig.journal(a.sessionId), { title: '', id: a.sessionId })).toMatch(/\*find stopped \(exit\)\* · \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n/);
  expect(a.closeReason).toBe('exit');
  expect(child!.closeReason).toBe('exit');
  expect(rig.registry.live()).toEqual([]);

  // The task ending afterwards delivers nowhere: the session is not parked, saved or
  // locked again.
  const before = fs.readFileSync(path.join(homeIn(rig.sessionsDir!, a.sessionId), `${a.sessionId}.json`), 'utf8');
  const rowsBefore = rig.journal(a.sessionId).filter((e) => e.t === 'row').length;
  task.release();
  await rig.until(() => rig.registry.children.backgroundCount() === 0, 3_000);
  await new Promise((r) => setTimeout(r, 20));
  expect(bgSaved(rig, a)).toEqual([]);
  expect(a.messages.filter((m) => m.role === 'bg')).toEqual([]);
  expect(rig.journal(a.sessionId).filter((e) => e.t === 'row')).toHaveLength(rowsBefore);
  expect(fs.readFileSync(path.join(homeIn(rig.sessionsDir!, a.sessionId), `${a.sessionId}.json`), 'utf8')).toBe(before);
  expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(false);
  expect(taskEnds(rig, a)).toHaveLength(1);
});

test('at exit the tree closes deepest first, and a grandchild says it stopped too', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'one', label: 'a' } }], [{ text: 'Started.' }]);
  const one = taskScript(model, 'one');
  one.script([{ tool: 'background', args: { task: 'two', label: 'b' } }], [{ hold: true }, { text: 'a done' }]);
  const two = taskScript(model, 'two');
  two.script([{ hold: true }, { text: 'b done' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const s = rig.conv;
  await s.send('go');
  await rig.until(() => one.held && two.held);
  const [taskA] = [...s.children];
  const [taskB] = [...taskA!.children];
  expect(taskB!.label).toBe('b');
  const order: string[] = [];
  for (const [name, c] of [['session', s], ['a', taskA!], ['b', taskB!]] as const) c.on('closed', () => { order.push(name); });
  rig.registry.closeAll('exit');
  expect(order).toEqual(['b', 'a', 'session']);
  expect(taskEnds(rig, s).map((e) => e.task).sort()).toEqual(['a', 'b']);
  expect(taskEnds(rig, s).every((e) => e.by === 'exit' && e.outcome === 'stopped')).toBe(true);
});

test('a flush writes and unlocks but closes nothing, and says nothing about the tasks', async () => {
  const { rig, a } = await headlessWithTask();
  const [child] = [...a.children];
  rig.registry.flushAll();
  expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(false);
  expect(a.closed).toBe(false);
  expect(child!.closed).toBe(false);
  expect(taskEnds(rig, a)).toEqual([]);
});

// A guest tool that needs no y/n and counts its runs.
function marker() {
  const runs = { n: 0 };
  const make = (m: Make) => m('marker', {
    tools: [{
      id: 'marker',
      tools: [{ type: 'function', function: { name: 'mark', description: 'Marks.', parameters: { type: 'object', properties: {} } } }],
      exec: async () => { runs.n++; return 'marked'; },
    }],
  });
  return { runs, make };
}

test('at exit a task in the middle of its turn stops: no tool call and no request after its task-end line', async () => {
  const mark = marker();
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'find it', label: 'find' } }], [{ text: 'Started.' }]);
  const task = taskScript(model, 'find it');
  task.script([{ hold: true }, { tool: 'mark', args: {} }], [{ text: 'found it' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false }, guests: (make) => [mark.make(make)] });
  const s = rig.conv;
  await s.send('find it in the background');
  await rig.until(() => task.held);
  const taskRequests = () => model.requests.filter((r) => system(r).includes('Task: find it')).length;
  expect(taskRequests()).toBe(1);
  rig.registry.closeAll('exit');
  task.release();
  await rig.until(() => rig.registry.children.backgroundCount() === 0, 3_000);
  await new Promise((r) => setTimeout(r, 20));
  const lines = rig.journal(s.sessionId).filter((e) => e.task === 'find').map((e) => e.t);
  expect(lines.at(-1)).toBe('task-end');
  expect(lines.slice(lines.indexOf('task-end'))).toEqual(['task-end']);
  expect(mark.runs.n).toBe(0);
  expect(taskRequests()).toBe(1);
});

// What the tool said about task `label`, on screen and in the log.
const saidAbout = (rig: Rig, label: string) => ({
  toasts: rig.toasts.filter((t) => t.includes(label)),
  log: rig.log.filter((l) => l.startsWith(`[bg] ${label}`)),
});

test('a task running at exit reads stopped, not failed: no toast, and the log says it stopped with its conversation', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'find it', label: 'find' } }], [{ text: 'Started.' }]);
  const task = taskScript(model, 'find it');
  task.script([{ hold: true }, { text: 'found it' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  await rig.conv.send('find it in the background');
  await rig.until(() => task.held);
  rig.registry.closeAll('exit');
  task.release();
  await rig.until(() => rig.registry.children.backgroundCount() === 0, 3_000);
  await new Promise((r) => setTimeout(r, 20));
  expect(saidAbout(rig, 'find')).toEqual({ toasts: [], log: ['[bg] find stopped with its conversation'] });
});

test('a task waiting on its delay at exit never starts: its timer is cleared, the count drops at once, and nothing is said', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'later', label: 'late', in: '0.2 seconds' } }], [{ text: 'Started.' }]);
  const task = taskScript(model, 'later');
  task.script([{ text: 'late done' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const s = rig.conv;
  await s.send('later, in the background');
  expect(s.childTimers.size).toBe(1);
  expect(rig.registry.children.backgroundCount()).toBe(1);
  rig.registry.closeAll('exit');
  expect(s.childTimers.size).toBe(0);
  expect(rig.registry.children.backgroundCount()).toBe(0);
  // Past the delay: a timer left armed would have fired by now.
  await new Promise((r) => setTimeout(r, 400));
  expect(model.requests.filter((r) => system(r).includes('Task: later'))).toHaveLength(0);
  expect(saidAbout(rig, 'late')).toEqual({ toasts: [], log: [] });
  expect(rig.registry.children.backgroundCount()).toBe(0);
});

// Whether a process group still has a member: signal 0 throws ESRCH once it is gone.
const groupAlive = (pid: number): boolean => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const killGroup = (pid: number): void => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } };
const groupGone = async (pid: number, ms = 3_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!groupAlive(pid)) return true; await new Promise((r) => setTimeout(r, 25)); }
  return !groupAlive(pid);
};
const readPid = (file: string): number | null => {
  try { const n = Number(fs.readFileSync(file, 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; }
};

test('at exit a session\'s !command is stopped: its process group is gone, and nothing is saved or said afterwards', async () => {
  const rig = conversationRig(new ScriptedModel());
  const s = rig.conv;
  const pidFile = path.join(rig.root, 'pid');
  let pid: number | null = null;
  try {
    const running = s.runShell(`echo $$ > '${pidFile}'; sleep 30`);
    await rig.until(() => readPid(pidFile) !== null);
    pid = readPid(pidFile);
    expect(groupAlive(pid!)).toBe(true);
    const saveDir = path.join(homeIn(rig.sessionsDir!, s.sessionId), `${s.sessionId}.json`);
    rig.registry.closeAll('exit');
    const before = fs.existsSync(saveDir) ? fs.readFileSync(saveDir, 'utf8') : null;
    const toasts = rig.toasts.length;
    expect(await groupGone(pid!)).toBe(true);
    await running;
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(saveDir) ? fs.readFileSync(saveDir, 'utf8') : null).toBe(before);
    expect(rig.toasts).toHaveLength(toasts);
    expect(fs.existsSync(lockOf(rig, s.sessionId))).toBe(false);
  } finally {
    if (pid) killGroup(pid);
  }
});

test('at exit a session turn\'s run_command is stopped: its process group is gone, and nothing is saved or said afterwards', async () => {
  const model = new ScriptedModel();
  const pidPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-exit-pid-')), 'pid');
  const pidFile = () => pidPath;
  model.script([{ tool: 'run_command', args: { command: `echo $$ > '${pidPath}'; sleep 30` } }], [{ text: 'never' }]);
  const rig = conversationRig(model, { shell: { autoRun: true }, policy: { kind: 'allow-writes', say: () => {} } });
  const s = rig.conv;
  let pid: number | null = null;
  try {
    const turn = s.send('run it');
    await rig.until(() => readPid(pidFile()) !== null);
    pid = readPid(pidFile());
    expect(groupAlive(pid!)).toBe(true);
    const saveFile = path.join(homeIn(rig.sessionsDir!, s.sessionId), `${s.sessionId}.json`);
    rig.registry.closeAll('exit');
    const before = fs.existsSync(saveFile) ? fs.readFileSync(saveFile, 'utf8') : null;
    const toasts = rig.toasts.length;
    expect(await groupGone(pid!)).toBe(true);
    await turn;
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(saveFile) ? fs.readFileSync(saveFile, 'utf8') : null).toBe(before);
    expect(rig.toasts).toHaveLength(toasts);
    expect(fs.existsSync(lockOf(rig, s.sessionId))).toBe(false);
  } finally {
    if (pid) killGroup(pid);
  }
});
