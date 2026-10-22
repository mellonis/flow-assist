// A question a subagent the person started puts to its parent waits for the person: parked in
// the child, offered with the y/n, counted by the badge, the toast and the picker's status,
// and never delivered to the session's inbox or model. A question routed to a model counts in
// none of them.
import { afterEach, expect, test } from 'bun:test';
import { askKey } from '../assistant/ask.ts';
import { scheduleChild } from '../assistant/child-schedule.ts';
import { parkedAt } from '../assistant/confirm-policy.ts';
import { NO_ANSWER, type Conversation } from '../assistant/conversation.ts';
import type { ChildSpec } from '../assistant/conversation-types.ts';
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
const settledAll = (rig: Rig) => rig.until(() => rig.registry.children.backgroundCount() === 0, 5_000);
const results = (req: RecordedRequest | undefined): string[] => (req?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content).replace(/^OK: /, ''));
const sessionRequests = (model: ScriptedModel): RecordedRequest[] => model.requests.filter((r) => !system(r).includes('You are a background worker'));

function scheduled(rig: Rig, s: ChildSpec) {
  const id = rig.conv.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const r = scheduleChild(s, 0, { startChild: (sp) => rig.conv.startChild(sp, id), slots: rig.registry.children, showMessage: rig.services.showMessage, pushLog: rig.services.pushLog });
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  children.push(r.child);
  return r.child;
}
// The person's keys, as the chat steps them.
const typed = (child: Conversation, ...names: string[]) => { for (const name of names) child.stepParentAsk(askKey(child.parentAsk!.state, { name })); };

test('a question of a subagent the person started stays parked for the person, never in the inbox or the model', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'job');
  sub.script(ask('which one?'), [{ text: 'done' }]);
  const rig = conversationRig(model, bg);
  const child = scheduled(rig, spec('maker', 'job'));
  await rig.until(() => child.parentAsk !== null);
  expect(rig.conv.inbox).toEqual([]);
  const o = rig.conv.offered()!;
  expect(o).toMatchObject({ kind: 'ask', owner: child, path: ['maker'] });
  expect(o.request).toBe(child.parentAsk!);
  const q = child.parentAsk!.state.questions;
  expect(q).toEqual([{ question: 'which one?', header: 'from «maker»', options: [] }]);
  expect(sessionRequests(model)).toHaveLength(0);
  typed(child, 'b', 'l', 'u', 'e');
  expect(rig.conv.offered()!.request.state.text).toBe('blue');
  expect(sub.requests).toHaveLength(1);
  typed(child, 'return');
  await settledAll(rig);
  expect(results(sub.requests[1])).toEqual(['The person answered: blue']);
  expect(rig.conv.offered()).toBeNull();
  expect(sessionRequests(model)).toHaveLength(0);
  expect(rig.subJournal('maker').filter((e) => e.t === 'ask-answer')).toMatchObject([{ by: 'person' }]);
});

test('Esc and an empty answer give the no-answer text', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'job');
  sub.script(ask('one?'), [{ text: 'done' }]);
  const rig = conversationRig(model, bg);
  const esc = scheduled(rig, spec('esc', 'job'));
  await rig.until(() => esc.parentAsk !== null);
  typed(esc, 'escape');
  await settledAll(rig);
  expect(results(sub.requests[1])).toEqual([NO_ANSWER]);
  expect(rig.subJournal('esc').filter((e) => e.t === 'ask-answer')).toMatchObject([{ by: 'none' }]);
  // A finished state with no text in it is no answer either.
  const blank = scheduled(rig, spec('blank', 'job2'));
  const none = blank.askParent('two?');
  blank.stepParentAsk({ ...blank.parentAsk!.state, done: true, answers: [{ question: 'two?', labels: [], other: '  ' }] });
  expect(await none).toBe(NO_ANSWER);
});

test('the oldest comes first, a y/n and a question by the time they were parked; the session\'s own y/n before both', async () => {
  const rig = conversationRig(new ScriptedModel(), bg);
  const a = scheduled(rig, spec('first', 'a'));
  const b = scheduled(rig, spec('second', 'b'));
  const c = scheduled(rig, spec('third', 'c'));
  void a.askParent('a?');
  c.drawConfirm({ name: 'run_command', args: '', at: parkedAt() });
  void b.askParent('b?');
  expect(rig.conv.offered()).toMatchObject({ kind: 'ask', owner: a });
  typed(a, 'x', 'return');
  expect(rig.conv.offered()).toMatchObject({ kind: 'confirm', owner: c });
  c.drawConfirm(null);
  expect(rig.conv.offered()).toMatchObject({ kind: 'ask', owner: b });
  rig.conv.drawConfirm({ name: 'run_command', args: '', at: parkedAt() });
  expect(rig.conv.offered()).toMatchObject({ kind: 'confirm', owner: rig.conv, path: [] });
  expect(rig.conv.offeredWithin(b)).toMatchObject({ kind: 'ask', owner: b });
  expect(rig.conv.offeredWithin(a)).toBeNull();
});

test('stopping the subagent, or clearing the session, takes the question away and ends the wait', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job').script(ask('which one?'), [{ text: 'never' }]);
  const rig = conversationRig(model, bg);
  const child = scheduled(rig, spec('maker', 'job'));
  await rig.until(() => child.parentAsk !== null);
  expect(rig.conv.offered()).not.toBeNull();
  child.stopSubtree('');
  await settledAll(rig);
  expect(rig.conv.offered()).toBeNull();
  expect(rig.conv.askedBelow()).toBeNull();
  expect(rig.conv.subtreeWaiting).toBe(false);
  const other = new ScriptedModel();
  subScript(other, 'job').script(ask('again?'), [{ text: 'never' }]);
  const second = conversationRig(other, bg);
  const kid = scheduled(second, spec('kid', 'job'));
  await second.until(() => kid.parentAsk !== null);
  second.conv.close('clear');
  await settledAll(second);
  expect(kid.parentAsk).toBeNull();
  expect(second.conv.offered()).toBeNull();
});

test('the badge, the toast and the picker\'s status count a question for the person, not one routed to a model', async () => {
  const model = new ScriptedModel();
  subScript(model, 'sub job').script(ask('for you?'), [{ text: 'done' }]);
  const rig = conversationRig(model, bg);
  const session = rig.conv;
  const child = scheduled(rig, spec('maker', 'sub job'));
  await rig.until(() => child.parentAsk !== null);
  expect(session.askedBelow()).toMatchObject({ label: 'maker', ask: { text: 'for you?' } });
  expect(session.subtreeWaiting).toBe(true);
  expect(rig.registry.statusOf(session.sessionId)).toBe('waiting');
  rig.switchTo();
  expect(rig.toasts.filter((t) => t.startsWith('⏸'))).toEqual(['⏸ an untitled session waits for your answer — a question from «maker»']);
  child.stepParentAsk(askKey(child.parentAsk!.state, { name: 'escape' }));
  await settledAll(rig);
  expect(rig.registry.statusOf(session.sessionId)).not.toBe('waiting');

  // A task asks: its question is routed to the session's model, parked here by hand.
  const other = new ScriptedModel();
  taskScript(other, 'task job').script(ask('for the model?'), [{ text: 'done' }]);
  const second = conversationRig(other, bg);
  const task = scheduled(second, spec('worker', 'task job', { kind: 'task', by: 'model' }));
  task.routeParentAsk = () => null;
  await second.until(() => task.parentAsk !== null);
  expect(second.conv.askedBelow()).toBeNull();
  expect(second.conv.offered()).toBeNull();
  expect(second.conv.subtreeWaiting).toBe(false);
  expect(second.registry.statusOf(second.conv.sessionId)).not.toBe('waiting');
  second.switchTo();
  expect(second.toasts.filter((t) => t.startsWith('⏸'))).toEqual([]);
  task.answerParentAsk('x', 'model');
  await settledAll(second);
});
