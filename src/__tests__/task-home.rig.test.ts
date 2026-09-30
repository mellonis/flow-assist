// A task's result goes to the session its chain started from (AGENTS.md (a conversation
// starts a child)), never to whatever the chat shows when it ends; the conversation that
// started a task counts it until its result is in.
import { afterEach, expect, test } from 'bun:test';
import type { Conversation } from '../assistant/conversation.ts';
import { exportMarkdown } from '../assistant/journal.ts';
import type { Make } from '../loader/plugin.ts';
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
  // Its task is over: only the grandchild runs, and the session counts it.
  const [grandchild] = [...first.children];
  expect(first.children.size).toBe(1);
  expect(grandchild!.label).toBe('b');
  expect(grandchild!.parent).toBe(first);
  rig.registry.show(rig.fresh());
  two.release();
  await rig.until(() => rig.registry.children.backgroundCount() === 0 && bgRows(first).length === 2, 3_000);
  expect(bgRows(first)).toEqual(['a finished:\na done', 'b finished:\nb done']);
  expect(rig.journal(first.sessionId).filter((e) => e.t === 'row' && e.role === 'bg').map((e) => e.text)).toEqual(['a finished:\na done', 'b finished:\nb done']);
  expect(bgRows(rig.conv)).toEqual([]);
  expect(rig.toasts).toContain(`⏳ b done — in «${first.title}»`);
  expect(first.children.size).toBe(0);
});

// A guest tool that waits for its signal's abort and records that it saw it.
function abortProbe() {
  const seen = { entered: false, aborted: false };
  const make = (m: Make) => m('probe', {
    tools: [{
      id: 'probe',
      tools: [{ type: 'function', function: { name: 'wait_abort', description: 'Waits for its signal.', parameters: { type: 'object', properties: {} } } }],
      exec: async (_name: string, _args: unknown, ctx: Record<string, unknown>) => {
        const signal = ctx.signal as AbortSignal;
        seen.entered = true;
        await new Promise<void>((r) => { if (signal.aborted) r(); else signal.addEventListener('abort', () => r()); });
        seen.aborted = signal.aborted;
        return 'aborted';
      },
    }],
  });
  return { seen, make };
}
const taskEnds = (rig: Rig, c: Conversation) => rig.journal(c.sessionId).filter((e) => e.t === 'task-end');

test('/clear stops a running task: nothing is delivered, the log and the journal say so', async () => {
  const probe = abortProbe();
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'wait', label: 'p' } }], [{ text: 'Started.' }]);
  taskScript(model, 'wait').script([{ tool: 'wait_abort', args: {} }], [{ text: 'never' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false }, guests: (make) => [probe.make(make)] });
  const first = rig.conv;
  rig.registry.show(first);
  await first.send('go');
  await rig.until(() => probe.seen.entered);
  const [child] = [...first.children];
  first.close('clear');
  expect(child!.closeReason).toBe('parent');
  expect(first.children.size).toBe(0);
  await rig.until(() => rig.registry.children.backgroundCount() === 0);
  expect(probe.seen.aborted).toBe(true);
  expect(bgRows(first)).toEqual([]);
  expect(rig.log).toContain('[bg] p stopped with its conversation');
  expect(rig.log.filter((l) => l.startsWith('[bg] p') && l !== '[bg] p stopped with its conversation')).toEqual([]);
  expect(rig.toasts.filter((t) => t.includes('p '))).toEqual([]);
  // The conversation /clear puts on screen gets nothing either.
  const next = rig.fresh();
  rig.registry.show(next);
  await new Promise((r) => setTimeout(r, 20));
  expect(bgRows(next)).toEqual([]);
  expect(taskEnds(rig, first)).toMatchObject([{ t: 'task-end', task: 'p', outcome: 'stopped', by: 'clear' }]);
  expect(exportMarkdown(rig.journal(first.sessionId), { title: '', id: first.sessionId })).toContain('*p stopped (clear)*');
});

test('/clear cancels a delayed task and disarms only what is still armed', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'background', args: { task: 'now', label: 'r' } }, { tool: 'background', args: { task: 'x', label: 'late', in: '3 minutes' } }],
    [{ text: 'Started.' }],
    [{ tool: 'background', args: { task: 'y', label: 'other', in: '3 minutes' } }],
    [{ text: 'Scheduled.' }],
  );
  const now = taskScript(model, 'now');
  now.script([{ hold: true }, { text: 'never' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  await first.send('go');
  await rig.until(() => now.held);
  // Another session's delayed task, which the clear must leave counted.
  const second = rig.fresh();
  await second.send('later');
  expect(rig.registry.children.backgroundCount()).toBe(3);
  const late = [...first.children].find((c) => c.label === 'late')!;
  first.close('clear');
  // The running one still settles; the delayed one is gone at once, the other session's stays.
  expect(rig.registry.children.backgroundCount()).toBe(2);
  expect(late.closeReason).toBe('parent');
  expect(first.childTimers.size).toBe(0);
  expect(second.childTimers.size).toBe(1);
  await rig.until(() => rig.registry.children.backgroundCount() === 1);
  expect(model.requests.some((r) => system(r).includes('Task: x'))).toBe(false);
  expect(taskEnds(rig, first).map((e) => e.task).sort()).toEqual(['late', 'r']);
});

test('/clear stops a task queued for a slot before it sends anything', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'one', label: 'a' } }, { tool: 'background', args: { task: 'two', label: 'b' } }], [{ text: 'Started.' }]);
  const one = taskScript(model, 'one');
  one.script([{ hold: true }, { text: 'never' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false }, extra: { sessions: { maxRunning: 2 } } });
  const first = rig.conv;
  await first.send('go');
  await rig.until(() => one.held && rig.registry.children.backgroundCount() === 2);
  first.close('clear');
  expect(rig.registry.children.backgroundCount()).toBe(2);
  await rig.until(() => rig.registry.children.backgroundCount() === 0);
  expect(model.requests.some((r) => system(r).includes('Task: two'))).toBe(false);
  expect(rig.log).toContain('[bg] a stopped with its conversation');
  expect(rig.log).toContain('[bg] b stopped with its conversation');
  expect(rig.toasts).toEqual([]);
});

test('/clear stops a task\'s own task too, each saying so in the session\'s journal', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'one', label: 'a' } }], [{ text: 'Started.' }]);
  const one = taskScript(model, 'one');
  one.script([{ tool: 'background', args: { task: 'two', label: 'b' } }], [{ hold: true }, { text: 'never' }]);
  const two = taskScript(model, 'two');
  two.script([{ hold: true }, { text: 'never' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  await first.send('go');
  await rig.until(() => one.held && two.held);
  const [a] = [...first.children];
  const [b] = [...a!.children];
  first.close('clear');
  expect(a!.closeReason).toBe('parent');
  expect(b!.closeReason).toBe('parent');
  await rig.until(() => rig.registry.children.backgroundCount() === 0);
  expect(taskEnds(rig, first)).toMatchObject([
    { task: 'a', outcome: 'stopped', by: 'clear' },
    { task: 'b', outcome: 'stopped', by: 'clear' },
  ]);
  expect(rig.log).toContain('[bg] a stopped with its conversation');
  expect(rig.log).toContain('[bg] b stopped with its conversation');
});

test('a delayed task whose task has ended is the session\'s, its timer with it, and /clear cancels it', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'one', label: 'a' } }], [{ text: 'Started.' }]);
  taskScript(model, 'one').script([{ tool: 'background', args: { task: 'two', label: 'b', in: '3 minutes' } }], [{ text: 'a done' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  await first.send('go');
  await rig.until(() => bgRows(first).length === 1 && rig.registry.children.backgroundCount() === 1, 3_000);
  const [b] = [...first.children];
  expect(b!.label).toBe('b');
  expect(first.childTimers.has(b!)).toBe(true);
  first.close('clear');
  expect(b!.closeReason).toBe('parent');
  expect(rig.registry.children.backgroundCount()).toBe(0);
});

// A running task and a delayed one; `reason` closes their session.
async function leftWithTasks(reason: 'new' | 'exit') {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'background', args: { task: 'now', label: 'r' } }, { tool: 'background', args: { task: 'x', label: 'late', in: '3 minutes' } }],
    [{ text: 'Started.' }],
  );
  const now = taskScript(model, 'now');
  now.script([{ hold: true }, { text: 'r done' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  await first.send('go');
  await rig.until(() => now.held);
  const tasks = [...first.children];
  first.close(reason);
  expect(tasks.map((t) => t.closed)).toEqual([false, false]);
  expect(first.children.size).toBe(2);
  expect(first.childTimers.size).toBe(1);
  expect(rig.registry.children.backgroundCount()).toBe(2);
  now.release();
  await rig.until(() => rig.registry.children.backgroundCount() === 1);
  expect(rig.log).toContain('[bg] r: r done');
  expect(taskEnds(rig, first)).toEqual([]);
}

test('/new stops none of the session\'s tasks', () => leftWithTasks('new'));
test('an exit close touches no task', () => leftWithTasks('exit'));
