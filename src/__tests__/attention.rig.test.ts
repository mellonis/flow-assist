// What the registry counts for the person's attention: the sessions left on a y/n or a
// question, and the ones put away with an answer nobody read (AGENTS.md (a host makes its
// conversations through one registry)).
import { afterEach, expect, test } from 'bun:test';
import type { Conversation } from '../assistant/conversation.ts';
import { ScriptedModel, firstUser } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';

afterEach(() => { closeRigs(); });

// A session on screen whose turn is held at its first request; the answer follows.
async function heldTurn() {
  const model = new ScriptedModel();
  const sub = model.when((req) => firstUser(req).includes('question A'));
  sub.script([{ hold: true }, { text: 'Answer A.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  rig.registry.show(rig.conv);
  void rig.conv.send('question A');
  await rig.until(() => sub.held && rig.conv.sessionId !== '');
  return { sub, rig };
}

// A session on screen whose turn stops at a y/n for `echo hi`.
async function yesNoTurn() {
  const model = new ScriptedModel();
  const sub = model.when((req) => firstUser(req).includes('question A'));
  sub.script([{ hold: true }, { tool: 'run_command', args: { command: 'echo hi' } }], [{ text: 'Ran it.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  rig.registry.show(rig.conv);
  void rig.conv.send('question A');
  await rig.until(() => sub.held && rig.conv.sessionId !== '');
  return { sub, rig };
}

// A session answered on screen, then left at rest: parked at once.
async function answeredAndLeft(rig: Rig): Promise<Conversation> {
  rig.registry.show(rig.conv);
  await rig.conv.send('question A');
  await rig.idle();
  return rig.switchTo().left;
}

test('a left session whose turn ends is parked and counted as done; opened again it is not', async () => {
  const { sub, rig } = await heldTurn();
  const { left: a } = rig.switchTo();
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
  sub.release();
  await rig.until(() => a.closed);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 1 });
  rig.open(a.sessionId);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
});

test('a session left on a y/n is counted as waiting; on screen again it is not, answered or not', async () => {
  const { sub, rig } = await yesNoTurn();
  const { left: a } = rig.switchTo();
  sub.release();
  await rig.until(() => !!rig.pendingIn(a));
  expect(rig.registry.attention()).toEqual({ waiting: 1, done: 0 });
  rig.switchTo(a);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 }); // still waiting, and on screen
  a.answerConfirm(true);
  await rig.until(() => !a.busy);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
});

test('the session on screen is never counted', async () => {
  const { sub, rig } = await yesNoTurn();
  sub.release();
  await rig.until(() => !!rig.pendingIn(rig.conv));
  expect(rig.registry.statusOf(rig.conv.sessionId)).toBe('waiting');
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
  expect(rig.registry.attention(rig.conv)).toEqual({ waiting: 0, done: 0 });
});

test('a session left while idle and already read adds nothing', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Answer A.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const a = await answeredAndLeft(rig);
  expect(a.closed).toBe(true);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
});

test('a session put away with a result that landed in the park is counted as done', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Answer A.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  rig.registry.show(rig.conv);
  await rig.conv.send('question A');
  await rig.idle();
  // A result waiting in the inbox: it lands as a row inside the park, after the answer
  // was read, so only the status read after the landing sees it unseen.
  (rig.conv as unknown as { inbox: string[] }).inbox.push('job finished:\nok');
  const { left: a } = rig.switchTo();
  expect(a.closed).toBe(true);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 1 });
});

test('a park that throws adds nothing', async () => {
  const { sub, rig } = await heldTurn();
  const { left: a } = rig.switchTo();
  a.save = () => { throw new Error('disk full'); };
  sub.release();
  await rig.until(() => rig.log.some((l) => l.includes('disk full')));
  expect(a.closed).toBe(false);
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
  a.save = () => {}; // let the rig close it
});

// A session put away unread whose result landed inside the park.
async function putAwayUnread(): Promise<{ rig: Rig; id: string }> {
  const model = new ScriptedModel();
  model.script([{ text: 'Answer A.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  rig.registry.show(rig.conv);
  await rig.conv.send('question A');
  await rig.idle();
  (rig.conv as unknown as { inbox: string[] }).inbox.push('job finished:\nok');
  const { left } = rig.switchTo();
  expect(rig.registry.attention().done).toBe(1);
  return { rig, id: left.sessionId };
}

test('attention leaves out the session it is told to', async () => {
  const { rig, id } = await putAwayUnread();
  // Another conversation holding the id of the one put away, as one opened where it is drawn.
  const twin = rig.fresh();
  twin.sessionId = id;
  expect(rig.registry.attention().done).toBe(1);
  expect(rig.registry.attention(twin).done).toBe(0);
});

test('taking a conversation back drops its id from the unread set', async () => {
  const { rig, id } = await putAwayUnread();
  const twin = rig.fresh();
  twin.sessionId = id;
  rig.registry.reclaim(twin);
  expect(rig.registry.attention().done).toBe(0);
});

test('forget notifies only when it removed something', async () => {
  const { rig, id } = await putAwayUnread();
  let heard = 0;
  rig.registry.onChange(() => { heard++; });
  rig.registry.forget('not-there');
  expect(heard).toBe(0);
  rig.registry.forget(id);
  expect(heard).toBe(1);
  expect(rig.registry.attention().done).toBe(0);
});
