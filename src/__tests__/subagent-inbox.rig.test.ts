// A result goes to the nearest conversation above that takes it: a task a subagent started
// lands in the subagent, whose later turn reads it through its schedule, and the answer of
// that turn goes up (AGENTS.md (a conversation starts a child)).
import { afterEach, expect, test } from 'bun:test';
import { scheduleChild } from '../assistant/child-schedule.ts';
import type { Conversation } from '../assistant/conversation.ts';
import type { ChildSpec } from '../assistant/conversation-types.ts';
import { ScriptedModel, type RecordedRequest } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';

const realFetch = globalThis.fetch;
const children: Conversation[] = [];
afterEach(() => { globalThis.fetch = realFetch; for (const c of children.splice(0)) c.close('exit'); closeRigs(); });

const system = (req: RecordedRequest): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
const subScript = (model: ScriptedModel, task: string) => model.when((req) => system(req).includes(`The person's task: ${task}`) && (req as { stream?: boolean }).stream === true);
const taskScript = (model: ScriptedModel, task: string) => model.when((req) => system(req).includes(`Task: ${task}`));
const spec = (label: string, prompt: string): ChildSpec => ({ kind: 'subagent', label, prompt, by: 'person' });
const bgRows = (c: Conversation): string[] => c.rows().filter((m) => m.role === 'bg').map((m) => String(m.content));
const lines = (rig: Rig) => rig.journal().filter((e) => e.t === 'subagent');
const startsTask = [{ tool: 'subagent', args: { task: 'two', label: 'g' } }];
const FRAMED = /<child-result n=([0-9a-f]{8})>\\ng finished:\\ng done\\n<\/child-result n=\1>/;
const inLastRequest = (req: RecordedRequest): string => JSON.stringify(req.messages);

function scheduled(rig: Rig, s: ChildSpec) {
  const from = rig.conv;
  const id = from.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const r = scheduleChild(s, 0, {
    startChild: (sp) => from.startChild(sp, id), slots: rig.registry.children,
    showMessage: rig.services.showMessage, pushLog: rig.services.pushLog, notify: () => {},
  });
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  children.push(r.child);
  return r.child;
}
const quiet = (rig: Rig) => rig.until(() => rig.registry.children.backgroundCount() === 0, 5_000);
// The session's own turns (a follow-up on a result) get this.
const main = (model: ScriptedModel) => model.script([{ text: 'noted' }], [{ text: 'noted' }], [{ text: 'noted' }]);
const withFollowUp = { inbox: true, ai: { backgroundFollowUp: true } };

test('a task a subagent starts lands in the subagent; one turn of it reads the framed result through a slot, and its answer reaches the session as the subagent\'s result', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'one');
  sub.script(startsTask, [{ text: 'started it' }], [{ hold: true }, { text: 'sub read it' }]);
  const task = taskScript(model, 'two');
  task.script([{ hold: true }, { text: 'g done' }]);
  main(model);
  const rig = conversationRig(model, withFollowUp);
  const session = rig.conv;
  const child = scheduled(rig, spec('s', 'one'));
  await rig.until(() => task.held);
  await rig.until(() => child.idle);
  task.release();
  // The turn runs through a slot: taken while it works, given back after.
  await rig.until(() => sub.held);
  expect(rig.registry.children.running()).toBe(1);
  expect(child.idle).toBe(false);
  expect(sub.requests).toHaveLength(3);
  expect(inLastRequest(sub.requests[2]!)).toMatch(FRAMED);
  expect(bgRows(child)).toEqual(['g finished:\ng done']);
  sub.release();
  await rig.until(() => child.idle);
  await quiet(rig);
  expect(rig.registry.children.running()).toBe(0);
  // One turn read it, and its answer is the session's.
  expect(sub.requests).toHaveLength(3);
  expect(bgRows(session)).toEqual(['s finished:\nstarted it', 's finished:\nsub read it']);
  const api = session.api.filter((m) => m.role === 'bg').map((m) => String(m.content));
  expect(api.at(-1)).toContain('from the subagent «s»');
  expect(child.unreadAnswers()).toEqual([]);
  expect(session.unreadAnswers()).toEqual([]);
  expect(lines(rig).map((e) => e.event)).toEqual(['start', 'answered', 'answered']);
});

test('the same with the subagent busy when the result arrives: held until its turn ends, then exactly one turn reads it', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'one');
  sub.script(startsTask, [{ hold: true }, { text: 'first done' }], [{ text: 'read it' }]);
  const task = taskScript(model, 'two');
  task.script([{ text: 'g done' }]);
  main(model);
  const rig = conversationRig(model, withFollowUp);
  const session = rig.conv;
  const child = scheduled(rig, spec('s', 'one'));
  await rig.until(() => sub.held);
  await rig.until(() => child.inbox.length === 1);
  expect(sub.requests).toHaveLength(2);
  expect(bgRows(child)).toEqual([]);
  sub.release();
  await rig.until(() => child.idle && bgRows(session).length === 2);
  await quiet(rig);
  expect(sub.requests).toHaveLength(3);
  expect(inLastRequest(sub.requests[2]!)).toMatch(FRAMED);
  expect(bgRows(child)).toEqual(['g finished:\ng done']);
  expect(bgRows(session)).toEqual(['s finished:\nfirst done', 's finished:\nread it']);
});

test('a tell and a result together make one turn whose answer goes up; a tell alone stays in the subagent', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'one');
  sub.script(startsTask, [{ hold: true }, { text: 'first done' }], [{ text: 'both read' }], [{ text: 'tell only' }]);
  const task = taskScript(model, 'two');
  task.script([{ text: 'g done' }]);
  main(model);
  const rig = conversationRig(model, withFollowUp);
  const session = rig.conv;
  const child = scheduled(rig, spec('s', 'one'));
  await rig.until(() => sub.held);
  await rig.until(() => child.inbox.length === 1);
  expect(child.receive('and mind this')).toEqual({ sent: 'queued' });
  sub.release();
  await rig.until(() => child.idle && bgRows(session).length === 2);
  await quiet(rig);
  expect(sub.requests).toHaveLength(3);
  expect(inLastRequest(sub.requests[2]!)).toMatch(FRAMED);
  expect(inLastRequest(sub.requests[2]!)).toContain('and mind this');
  expect(bgRows(session)).toEqual(['s finished:\nfirst done', 's finished:\nboth read']);
  // The tell alone: the answer stays, the row says `answered`.
  expect(child.receive('just you')).toEqual({ sent: 'started' });
  await rig.until(() => child.idle && sub.requests.length === 4);
  await quiet(rig);
  expect(bgRows(session)).toEqual(['s finished:\nfirst done', 's finished:\nboth read']);
  expect(session.unreadAnswers()).toEqual([child]);
  expect(child.lastAnswer()).toBe('tell only');
});

test('a stopped task\'s result lands quiet in the subagent and starts no turn', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'one');
  sub.script(startsTask, [{ text: 'started it' }]);
  const task = taskScript(model, 'two');
  task.script([{ hold: true }, { text: 'never' }]);
  main(model);
  const rig = conversationRig(model, withFollowUp);
  const child = scheduled(rig, spec('s', 'one'));
  await rig.until(() => task.held);
  await rig.until(() => child.idle);
  const g = [...child.children][0]!;
  expect(g.stopSubtree('person')).toBe(true);
  await rig.until(() => bgRows(child).length === 1);
  await quiet(rig);
  expect(sub.requests).toHaveLength(2);
  expect(child.idle).toBe(true);
  expect(bgRows(child)[0]).toContain('g');
});

test('with ai.backgroundFollowUp false the result lands as rows in the subagent and no turn runs', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'one');
  sub.script(startsTask, [{ text: 'started it' }]);
  const task = taskScript(model, 'two');
  task.script([{ hold: true }, { text: 'g done' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  const session = rig.conv;
  const child = scheduled(rig, spec('s', 'one'));
  await rig.until(() => task.held);
  await rig.until(() => child.idle);
  task.release();
  await rig.until(() => bgRows(child).length === 1);
  await quiet(rig);
  expect(sub.requests).toHaveLength(2);
  expect(child.idle).toBe(true);
  expect(bgRows(session)).toEqual(['s finished:\nstarted it']);
});

test('a row landing in a subagent tells the tree, so the host redraws', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'one');
  sub.script(startsTask, [{ text: 'started it' }]);
  const task = taskScript(model, 'two');
  task.script([{ hold: true }, { text: 'g done' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  const child = scheduled(rig, spec('s', 'one'));
  await rig.until(() => task.held);
  await rig.until(() => child.idle);
  let heard = 0;
  rig.conv.on('tree', () => { heard++; });
  task.release();
  await rig.until(() => bgRows(child).length === 1);
  expect(heard).toBeGreaterThan(0);
});

test('a task whose result lands in a subagent does not claim it is on screen', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'one');
  sub.script(startsTask, [{ text: 'started it' }]);
  const task = taskScript(model, 'two');
  task.script([{ hold: true }, { text: 'g done' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  rig.registry.show(rig.conv);
  const child = scheduled(rig, spec('s', 'one'));
  await rig.until(() => task.held);
  await rig.until(() => child.idle);
  task.release();
  await rig.until(() => bgRows(child).length === 1);
  await rig.until(() => rig.toasts.some((t) => t.startsWith('⏳ g done')));
  expect(rig.toasts).toContain('⏳ g done — in «s»');
});
