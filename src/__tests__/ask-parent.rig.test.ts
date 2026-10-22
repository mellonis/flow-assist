// `ask_parent`: a task or a subagent puts one question to the conversation that started it
// and waits for the answer as a child waits on a y/n (AGENTS.md (a conversation starts a
// child of its own)).
import { afterEach, expect, test } from 'bun:test';
import { scheduleChild } from '../assistant/child-schedule.ts';
import { parkedAt } from '../assistant/confirm-policy.ts';
import { NO_ANSWER, type Conversation } from '../assistant/conversation.ts';
import type { ChildSpec } from '../assistant/conversation-types.ts';
import { exportMarkdown } from '../assistant/journal.ts';
import { ScriptedModel, type RecordedRequest } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';

const realFetch = globalThis.fetch;
const children: Conversation[] = [];
afterEach(() => { globalThis.fetch = realFetch; for (const c of children.splice(0)) c.close('exit'); closeRigs(); });

const system = (req: RecordedRequest): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
const subScript = (model: ScriptedModel, task: string) => model.when((req) => system(req).includes(`The person's task: ${task}`) && (req as { stream?: boolean }).stream === true);
const taskScript = (model: ScriptedModel, task: string) => model.when((req) => system(req).includes(`Task: ${task}`) && (req as { stream?: boolean }).stream === true);
const spec = (label: string, prompt: string, over: Partial<ChildSpec> = {}): ChildSpec => ({ kind: 'subagent', label, prompt, by: 'person', ...over });
const ask = (question: string) => [{ tool: 'ask_parent', args: { question } }];
const bg = { ai: { backgroundFollowUp: false } };
const counts = (rig: Rig) => ({ held: rig.registry.children.running(), waiting: rig.registry.children.waitingCount(), background: rig.registry.children.backgroundCount() });
const settledAll = (rig: Rig) => rig.until(() => rig.registry.children.backgroundCount() === 0, 5_000);
const toolNames = (req: RecordedRequest | undefined): string[] => ((req?.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
// The tool results a request carried, without the `OK: ` the loop puts in front of a result.
const results = (req: RecordedRequest | undefined): string[] => (req?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content).replace(/^OK: /, ''));

function scheduled(rig: Rig, s: ChildSpec, from: Conversation = rig.conv) {
  const id = from.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const r = scheduleChild(s, 0, { startChild: (sp) => from.startChild(sp, id), slots: rig.registry.children, showMessage: rig.services.showMessage, pushLog: rig.services.pushLog });
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  children.push(r.child);
  return r.child;
}
// A child whose question stays parked, as a route that settles it later leaves it.
function holding(rig: Rig, s: ChildSpec) {
  const child = scheduled(rig, s);
  child.routeParentAsk = () => null;
  return child;
}

test('ask_parent is offered to a task and to a subagent turn, not to a session or a one-shot turn', async () => {
  const model = new ScriptedModel();
  subScript(model, 'sub job').script([{ text: 'ok' }]);
  taskScript(model, 'task job').script([{ text: 'ok' }]);
  const rig = conversationRig(model, bg);
  scheduled(rig, spec('s', 'sub job'));
  scheduled(rig, spec('t', 'task job', { kind: 'task', by: 'model' }));
  await settledAll(rig);
  const subReq = model.requests.find((r) => system(r).includes("The person's task: sub job"));
  const taskReq = model.requests.find((r) => system(r).includes('Task: task job'));
  expect(toolNames(subReq)).toContain('ask_parent');
  expect(toolNames(taskReq)).toContain('ask_parent');
  const chat = new ScriptedModel();
  chat.script([{ text: 'hi' }]);
  const session = conversationRig(chat, bg);
  await session.conv.send('hello');
  expect(toolNames(chat.requests[0]).length).toBeGreaterThan(0);
  expect(toolNames(chat.requests[0])).not.toContain('ask_parent');
  const once = new ScriptedModel();
  once.script([{ text: 'hi' }]);
  const oneshot = conversationRig(once, { ...bg, kind: 'oneshot' });
  await oneshot.conv.send('hello');
  expect(toolNames(once.requests[0]).length).toBeGreaterThan(0);
  expect(toolNames(once.requests[0])).not.toContain('ask_parent');
});

test('a child that asks gives its slot up, the tree says `asks`, the ancestors wait, and the answer takes the slot back', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job').script(ask('which one?'), [{ text: 'done' }]);
  const rig = conversationRig(model, bg);
  const session = rig.conv;
  let askings = 0;
  session.on('asking', () => { askings++; });
  const child = holding(rig, spec('maker', 'job'));
  await rig.until(() => child.parentAsk !== null);
  expect(counts(rig)).toEqual({ held: 0, waiting: 1, background: 1 });
  expect(askings).toBeGreaterThan(0);
  expect(session.subtreeWaiting).toBe(true);
  expect(session.runningChildren()).toMatchObject([{ label: 'maker', status: 'asks' }]);
  expect(session.tree()).toMatchObject([{ label: 'maker', status: 'asks' }]);
  expect(session.askedBelow()).toMatchObject({ label: 'maker', ask: { text: 'which one?' } });
  expect(rig.registry.statusOf(session.sessionId)).toBe('waiting');
  child.answerParentAsk('the blue one', 'model');
  expect(counts(rig)).toEqual({ held: 1, waiting: 0, background: 1 });
  expect(session.subtreeWaiting).toBe(false);
  await settledAll(rig);
  expect(counts(rig)).toEqual({ held: 0, waiting: 0, background: 0 });
  expect(results(model.requests.at(-1))).toContain('the blue one');
});

test('a session left while its child asks says so once, naming the child', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job').script(ask('which one?'), [{ text: 'done' }]);
  const rig = conversationRig(model, bg);
  const session = rig.conv;
  const child = holding(rig, spec('maker', 'job'));
  await rig.until(() => child.parentAsk !== null);
  rig.switchTo();
  expect(rig.toasts.filter((t) => t.startsWith('⏸'))).toEqual(['⏸ an untitled session waits for your answer — a question from «maker»']);
  child.answerParentAsk('x', 'model');
  await settledAll(rig);
  expect(rig.registry.statusOf(session.sessionId)).not.toBe('waiting');
});

test('a y/n and a question pending together are one wait; settling one keeps it, settling both releases it', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job').script(ask('which one?'), [{ text: 'done' }]);
  const rig = conversationRig(model, bg);
  const child = holding(rig, spec('maker', 'job'));
  await rig.until(() => child.parentAsk !== null);
  expect(counts(rig).waiting).toBe(1);
  // A y/n parked beside the question, as the child's own events say it.
  child.confirm = { name: 'run_command', args: '', resolve: () => {} };
  child.emit({ type: 'confirm', request: { name: 'run_command', args: '', at: parkedAt() } });
  expect(counts(rig)).toEqual({ held: 0, waiting: 1, background: 1 });
  child.answerParentAsk('a', 'model');
  expect(counts(rig)).toEqual({ held: 0, waiting: 1, background: 1 });
  child.confirm = null;
  child.emit({ type: 'confirm', request: null });
  expect(counts(rig)).toEqual({ held: 1, waiting: 0, background: 1 });
  await settledAll(rig);
  expect(counts(rig)).toEqual({ held: 0, waiting: 0, background: 0 });
});

test('a y/n settled first, then the question: still one wait, then none', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job').script(ask('which one?'), [{ text: 'done' }]);
  const rig = conversationRig(model, bg);
  const child = holding(rig, spec('maker', 'job'));
  await rig.until(() => child.parentAsk !== null);
  child.confirm = { name: 'run_command', args: '', resolve: () => {} };
  child.emit({ type: 'confirm', request: { name: 'run_command', args: '', at: parkedAt() } });
  child.confirm = null;
  child.emit({ type: 'confirm', request: null });
  expect(counts(rig)).toEqual({ held: 0, waiting: 1, background: 1 });
  child.answerParentAsk('a', 'model');
  expect(counts(rig)).toEqual({ held: 1, waiting: 0, background: 1 });
  await settledAll(rig);
});

test('a stop while the child asks ends its turn, leaves the counts right and answers the tool `ask_parent: stopped`', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job').script(ask('which one?'), [{ text: 'never' }]);
  const rig = conversationRig(model, bg);
  const child = holding(rig, spec('maker', 'job'));
  await rig.until(() => child.parentAsk !== null);
  child.stopSubtree('');
  await settledAll(rig);
  expect(counts(rig)).toEqual({ held: 0, waiting: 0, background: 0 });
  expect(child.parentAsk).toBeNull();
  const lines = rig.subJournal('maker');
  expect(lines.filter((e) => e.t === 'ask-answer')).toMatchObject([{ by: 'none' }]);
  // The answer precedes the closing line of the file.
  expect(lines.findIndex((e) => e.t === 'ask-answer')).toBeLessThan(lines.findIndex((e) => e.t === 'end'));
});

test('the stop key on a child that asks settles the question and ends the turn', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job').script(ask('which one?'), [{ text: 'never' }]);
  const rig = conversationRig(model, bg);
  const child = holding(rig, spec('maker', 'job'));
  await rig.until(() => child.parentAsk !== null);
  expect(child.stop('')).toBe(true);
  expect(child.parentAsk).toBeNull();
  await settledAll(rig);
  expect(counts(rig)).toEqual({ held: 0, waiting: 0, background: 0 });
});

test('the wait ends as the tool reports when it is stopped or reset', async () => {
  const rig = conversationRig(new ScriptedModel(), bg);
  const child = holding(rig, spec('maker', 'job'));
  const stopped = child.askParent('one?');
  child.answerParentAsk('', 'stop');
  expect(await stopped).toBe('ask_parent: stopped');
  const reset = child.askParent('two?');
  child.answerParentAsk('', 'reset');
  expect(await reset).toBe('ask_parent: stopped');
  child.close('exit');
});

test('clearing the session while a child asks releases the wait', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job').script(ask('which one?'), [{ text: 'never' }]);
  const rig = conversationRig(model, bg);
  const child = holding(rig, spec('maker', 'job'));
  await rig.until(() => child.parentAsk !== null);
  rig.conv.close('clear');
  await settledAll(rig);
  expect(counts(rig)).toEqual({ held: 0, waiting: 0, background: 0 });
  expect(child.parentAsk).toBeNull();
});

test('a second question while one waits is answered at once with the error and leaves the first parked', async () => {
  const rig = conversationRig(new ScriptedModel(), bg);
  const child = holding(rig, spec('maker', 'job'));
  const first = child.askParent('first?');
  expect(await child.askParent('second?')).toBe('ask_parent: a question is already waiting for its answer');
  expect(child.parentAsk?.text).toBe('first?');
  child.answerParentAsk('yes', 'model');
  expect(await first).toBe('yes');
  child.close('exit');
});

test('with no route that holds it, a subagent the person started and a task are answered at once and neither hangs', async () => {
  const model = new ScriptedModel();
  subScript(model, 'sub job').script(ask('sub question?'), [{ text: 'sub done' }]);
  taskScript(model, 'task job').script(ask('task question?'), [{ text: 'task done' }]);
  const rig = conversationRig(model, bg);
  const sub = scheduled(rig, spec('s', 'sub job'));
  const task = scheduled(rig, spec('t', 'task job', { kind: 'task', by: 'model' }));
  await settledAll(rig);
  expect(sub.parentAsk).toBeNull();
  expect(task.parentAsk).toBeNull();
  const answered = model.requests.map((r) => results(r)).flat().filter((t) => t === NO_ANSWER);
  expect(answered).toHaveLength(2);
  expect(NO_ANSWER).toBe('no answer — proceed on your best assumption and name it in your result');
  expect(counts(rig)).toEqual({ held: 0, waiting: 0, background: 0 });
});

test('the journal keeps the question and its answer: a subagent in its own file, a task in the session journal; /export shows them', async () => {
  const model = new ScriptedModel();
  subScript(model, 'sub job').script(ask('sub question?'), [{ text: 'sub done' }]);
  taskScript(model, 'task job').script(ask('task question?'), [{ text: 'task done' }]);
  const rig = conversationRig(model, bg);
  scheduled(rig, spec('s', 'sub job'));
  scheduled(rig, spec('t', 'task job', { kind: 'task', by: 'model' }));
  await settledAll(rig);
  const own = rig.subJournal('s');
  const asked = own.find((e) => e.t === 'ask-parent');
  expect(asked).toMatchObject({ question: 'sub question?' });
  expect(own.find((e) => e.t === 'ask-answer' && e.id === asked!.id)).toMatchObject({ by: 'none' });
  const inSession = rig.journal();
  const taskAsk = inSession.find((e) => e.t === 'ask-parent' && e.task === 't');
  expect(taskAsk).toMatchObject({ question: 'task question?' });
  expect(inSession.find((e) => e.t === 'ask-answer' && e.id === taskAsk!.id && e.task === 't')).toMatchObject({ by: 'none' });
  // Only the settlement of the question is kept; the task's own assistant answer is not.
  expect(inSession.filter((e) => e.t === 'answer' && e.task === 't')).toEqual([]);
  const md = exportMarkdown(inSession, { title: 't', id: rig.conv.sessionId, child: (id) => rig.subJournals().find((j) => j.id === id)?.events ?? null });
  expect(md).toContain('Asked its parent');
  expect(md).toContain('sub question?');
  expect(md).toContain('task question?');
  expect(md).toContain('no answer was given');
});
