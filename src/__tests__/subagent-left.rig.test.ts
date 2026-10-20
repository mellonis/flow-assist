// A session the chat leaves while a subagent the person started rests in it stays loaded.
// What lands in it while nobody looks is said as for a session put away: its own answer
// unread, and a later answer of the subagent (AGENTS.md (a host makes its conversations
// through one registry)).
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
const noFollowUp = { ai: { backgroundFollowUp: false } };

function scheduled(rig: Rig, label: string, prompt: string) {
  const spec: ChildSpec = { kind: 'subagent', label, prompt, by: 'person' };
  const id = rig.conv.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const r = scheduleChild(spec, 0, {
    startChild: (sp) => rig.conv.startChild(sp, id), slots: rig.registry.children,
    showMessage: rig.services.showMessage, pushLog: rig.services.pushLog, notify: () => {},
  });
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  children.push(r.child);
  return r.child;
}
const quiet = (rig: Rig) => rig.until(() => rig.registry.children.backgroundCount() === 0, 5_000);
const finished = (rig: Rig): string[] => rig.toasts.filter((t) => t.includes('its answer is unread'));
const answered = (rig: Rig): string[] => rig.toasts.filter((t) => t.includes('answered — open the session to read it'));

// A session with a subagent resting in it, and its own turn held at the first request.
async function restingWithTurn() {
  const model = new ScriptedModel();
  subScript(model, 'rest').script([{ text: 'resting' }]);
  const own = model.when((req) => !system(req).includes("The person's task:") && JSON.stringify(req.messages).includes('question A'));
  own.script([{ hold: true }, { text: 'Answer A.' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  rig.registry.show(rig.conv);
  const child = scheduled(rig, 'rester', 'rest');
  await rig.until(() => child.idle);
  await quiet(rig);
  const session = rig.conv;
  void session.send('question A');
  await rig.until(() => own.held);
  return { rig, own, child, session };
}

test('a session kept for its subagent whose own turn ends unread says so once and counts as done; opened, it counts no more', async () => {
  const { rig, own, session } = await restingWithTurn();
  expect(rig.switchTo().outcome).toBe('kept');
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
  own.release();
  await rig.until(() => finished(rig).length === 1);
  expect(session.closed).toBe(false);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 1 });
  // Coming back: shown sessions are never counted.
  rig.switchTo(session);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
  expect(finished(rig)).toHaveLength(1);
});

test('a session whose answer is seen says nothing and counts nothing, subagent or not', async () => {
  const { rig, own } = await restingWithTurn();
  own.release();
  await rig.idle();
  await new Promise((r) => setTimeout(r, 30));
  expect(finished(rig)).toEqual([]);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
});

test('the kept session, put away once its subagent is stopped, does not say it twice', async () => {
  const { rig, own, child, session } = await restingWithTurn();
  rig.switchTo();
  own.release();
  await rig.until(() => finished(rig).length === 1);
  child.stopSubtree('x');
  await rig.until(() => session.closed, 2_000);
  expect(finished(rig)).toHaveLength(1);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 1 });
});

test('a session with no subagent is put away as before: one toast, one count', async () => {
  const model = new ScriptedModel();
  const own = model.when((req) => !system(req).includes("The person's task:") && JSON.stringify(req.messages).includes('question A'));
  own.script([{ hold: true }, { text: 'Answer A.' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  rig.registry.show(rig.conv);
  const a = rig.conv;
  void a.send('question A');
  await rig.until(() => own.held);
  rig.switchTo();
  own.release();
  await rig.until(() => a.closed);
  expect(finished(rig)).toHaveLength(1);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 1 });
});

async function restingSubagent() {
  const model = new ScriptedModel();
  subScript(model, 'talk').script([{ text: 'first' }], [{ text: 'second' }], [{ text: 'third' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  rig.registry.show(rig.conv);
  const child = scheduled(rig, 'talker', 'talk');
  await rig.until(() => child.idle);
  await quiet(rig);
  return { rig, child };
}

test('an answer to a tell that lands in a left session is named once, and the session counts as done until it is read', async () => {
  const { rig, child } = await restingSubagent();
  const session = rig.conv;
  expect(rig.switchTo().outcome).toBe('kept');
  expect(child.receive('more?')).toEqual({ sent: 'started' });
  await rig.until(() => answered(rig).length === 1);
  expect(answered(rig)[0]).toContain('«talker»');
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 1 });
  // Read in the watch: the mark clears, and so does the count.
  child.seeAnswer();
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
  // The next answer is said again.
  child.receive('and again?');
  await rig.until(() => answered(rig).length === 2);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 1 });
  // Opened here, the session is never counted.
  rig.switchTo(session);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
});

test('an answer that lands while the session is shown says nothing: the row says answered', async () => {
  const { rig, child } = await restingSubagent();
  child.receive('more?');
  await rig.until(() => child.idle && child.lastAnswer() === 'second');
  await new Promise((r) => setTimeout(r, 30));
  expect(answered(rig)).toEqual([]);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
  expect(rig.conv.tree()[0]!.answered).toBe(true);
});

test('an answer is said when it lands even when another message already waits, so the next turn begins at once', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'talk');
  sub.script([{ text: 'first' }], [{ hold: true }, { text: 'second' }], [{ hold: true }, { text: 'third' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  rig.registry.show(rig.conv);
  const child = scheduled(rig, 'talker', 'talk');
  await rig.until(() => child.idle);
  await quiet(rig);
  rig.switchTo();
  child.receive('one');
  await rig.until(() => sub.held);
  child.receive('two');
  sub.release();
  // The next turn is held; the answer before it has been said.
  await rig.until(() => sub.requests.length === 3 && sub.held);
  expect(answered(rig)).toHaveLength(1);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 1 });
  sub.release();
  await rig.until(() => child.idle);
});
