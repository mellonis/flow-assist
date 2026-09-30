// A task's result goes to the session its chain started from (AGENTS.md (a conversation
// starts a child)), never to whatever the chat shows when it ends; the conversation that
// started a task counts it until its result is in.
import { afterEach, expect, test } from 'bun:test';
import type { Conversation } from '../assistant/conversation.ts';
import { ScriptedModel, type RecordedRequest } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; closeRigs(); });

const WORKER = 'You are a background worker';
const system = (req: RecordedRequest): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
const taskScript = (model: ScriptedModel, task: string) => model.when((req) => system(req).includes(WORKER) && system(req).includes(`Task: ${task}`));
const bgRows = (c: Conversation): string[] => c.rows().filter((m) => m.role === 'bg').map((m) => String(m.content));

// A conversation that starts a task whose request waits for `release()`; `postToChat`
// delivers into whatever the rig holds, as the chat binds it, so a result sent there
// would show.
async function startHeld(label: string) {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'find it', label } }], [{ text: 'Started.' }]);
  const task = taskScript(model, 'find it');
  task.script([{ hold: true }, { text: 'found it' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  rig.registry.show(first);
  await rig.conv.send('find it in the background');
  await rig.until(() => task.held);
  // Its title is set by its first save, from the first line the person wrote.
  await rig.until(() => first.title !== '');
  return { rig, first, task };
}
const settled = (rig: Rig, first: Conversation) => rig.until(() => rig.registry.children.backgroundCount() === 0 && bgRows(first).length === 1, 3_000);

test('a result lands in the conversation that started it, though another is current now', async () => {
  const { rig, first, task } = await startHeld('find');
  const second = rig.fresh();
  rig.registry.show(second);
  task.release();
  await settled(rig, first);
  expect(rig.conv).toBe(second);
  expect(bgRows(first)).toEqual(['find finished:\nfound it']);
  expect(rig.journal(first.sessionId).filter((e) => e.t === 'row' && e.role === 'bg').map((e) => e.text)).toEqual(['find finished:\nfound it']);
  expect(bgRows(second)).toEqual([]);
  expect(rig.journal(second.sessionId).filter((e) => e.t === 'row' && e.role === 'bg')).toEqual([]);
  // The toast is the chat's, so it names where the result went.
  expect(rig.toasts).toContain(`⏳ find done — in «${first.title}»`);
  expect(rig.log).toContain('[bg] find: found it');
});

test('a result landing in an untitled session says so', async () => {
  const { rig, first, task } = await startHeld('find');
  first.title = '';
  rig.registry.show(rig.fresh());
  task.release();
  await settled(rig, first);
  expect(rig.toasts).toContain('⏳ find done — in an untitled session');
});

test('a result landing in the conversation on screen names none', async () => {
  const { rig, first, task } = await startHeld('find');
  task.release();
  await settled(rig, first);
  expect(rig.toasts).toContain('⏳ find done');
  expect(rig.toasts.filter((t) => t.includes(' — in '))).toEqual([]);
});

test('`children` counts a task from its start to its result, and the result is in before it is untracked', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'find it', label: 'find' } }], [{ text: 'Started.' }]);
  taskScript(model, 'find it').script([{ text: 'found it' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  const seen: { count: number; landed: number }[] = [];
  first.on('children', (ev) => { seen.push({ count: ev.count, landed: bgRows(first).length }); });
  await first.send('find it in the background');
  await settled(rig, first);
  expect(seen).toEqual([{ count: 1, landed: 0 }, { count: 0, landed: 1 }]);
  expect(first.children.size).toBe(0);
  expect(first.childTimers.size).toBe(0);
});

test('a delayed task is one of its conversation\'s children while armed, its timer with it', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'x', label: 'late', in: '3 minutes' } }], [{ text: 'Scheduled.' }]);
  const rig = conversationRig(model);
  await rig.conv.send('later, please');
  expect(rig.conv.children.size).toBe(1);
  const [child] = [...rig.conv.children];
  expect(rig.conv.childTimers.has(child!)).toBe(true);
});

test('a grandchild\'s result lands in the session, though the task that started it has finished', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'one', label: 'a' } }], [{ text: 'Started.' }]);
  taskScript(model, 'one').script([{ tool: 'background', args: { task: 'two', label: 'b' } }], [{ text: 'a done' }]);
  const two = taskScript(model, 'two');
  two.script([{ hold: true }, { text: 'b done' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  rig.registry.show(first);
  await first.send('go');
  await rig.until(() => two.held && bgRows(first).length === 1 && first.title !== '', 3_000);
  // Its task is over: only the grandchild runs.
  expect(first.children.size).toBe(0);
  rig.registry.show(rig.fresh());
  two.release();
  await rig.until(() => rig.registry.children.backgroundCount() === 0 && bgRows(first).length === 2, 3_000);
  expect(bgRows(first)).toEqual(['a finished:\na done', 'b finished:\nb done']);
  expect(rig.journal(first.sessionId).filter((e) => e.t === 'row' && e.role === 'bg').map((e) => e.text)).toEqual(['a finished:\na done', 'b finished:\nb done']);
  expect(bgRows(rig.conv)).toEqual([]);
  expect(rig.toasts).toContain(`⏳ b done — in «${first.title}»`);
});
