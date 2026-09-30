// At exit every live conversation is saved and unlocked, each task still counted says in
// its session's journal that it stopped, and everything closes, deepest first
// (AGENTS.md (a host makes its conversations through one registry)).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { Conversation } from '../assistant/conversation.ts';
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
  expect(exportMarkdown(rig.journal(a.sessionId), { title: '', id: a.sessionId })).toContain('*find stopped (exit)*');
  expect(a.closeReason).toBe('exit');
  expect(child!.closeReason).toBe('exit');
  expect(rig.registry.live()).toEqual([]);

  // The task ending afterwards delivers nowhere: the session is not parked, saved or
  // locked again.
  const before = fs.readFileSync(path.join(homeIn(rig.sessionsDir!, a.sessionId), `${a.sessionId}.json`), 'utf8');
  task.release();
  await rig.until(() => rig.registry.children.backgroundCount() === 0, 3_000);
  await new Promise((r) => setTimeout(r, 20));
  expect(bgSaved(rig, a)).toEqual([]);
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
