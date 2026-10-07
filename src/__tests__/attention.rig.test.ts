// What the registry counts for the person's attention: the sessions left on a y/n or a
// question, and the ones put away with an answer nobody read (AGENTS.md (a host makes its
// conversations through one registry)).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import type { Conversation } from '../assistant/conversation.ts';
import { ScriptedModel, firstUser } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';

afterEach(() => { closeRigs(); });

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

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
  rig.conv.inbox.push({ text: 'job finished:\nok', quiet: false });
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
  rig.conv.inbox.push({ text: 'job finished:\nok', quiet: false });
  const { left } = rig.switchTo();
  expect(rig.registry.attention().done).toBe(1);
  return { rig, id: left.sessionId };
}

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

test('keepUnseen drops the ids a read did not find, and notifies once only when it dropped some', async () => {
  const { rig, id } = await putAwayUnread();
  let heard = 0;
  rig.registry.onChange(() => { heard++; });
  rig.registry.keepUnseen([id, 'another']);
  expect(heard).toBe(0);
  expect(rig.registry.attention().done).toBe(1);
  rig.registry.keepUnseen(['another']);
  expect(heard).toBe(1);
  expect(rig.registry.attention().done).toBe(0);
});

// What a left session's finish says: a toast, never an alert.
const finished = (rig: Rig) => rig.toasts.filter((t) => t.includes('finished — its answer is unread'));
const withAlerts = (rig: Rig): string[] => {
  const alerts: string[] = [];
  (rig.services as unknown as { alert: (t: string, b?: string) => void }).alert = (_t, b) => { alerts.push(String(b)); };
  return alerts;
};

test('a session left that finishes says so once by a toast and raises no alert', async () => {
  const { sub, rig } = await heldTurn();
  const alerts = withAlerts(rig);
  const { left: a } = rig.switchTo();
  sub.release();
  await rig.until(() => a.closed);
  expect(a.title).not.toBe('');
  expect(finished(rig)).toEqual([`● «${a.title}» finished — its answer is unread`]);
  expect(alerts).toEqual([]);
  expect(rig.registry.attention().done).toBe(1);
  await tick(50);
  expect(finished(rig)).toHaveLength(1);
});

test('a session with no title is named as untitled', async () => {
  const { sub, rig } = await heldTurn();
  const { left: a } = rig.switchTo();
  // The title is fixed by a save, which the park does first: a save that writes nothing leaves none.
  a.save = () => {};
  a.title = '';
  sub.release();
  await rig.until(() => a.closed);
  expect(finished(rig)).toEqual(['● an untitled session finished — its answer is unread']);
});

test('a conversation parked without ever being left says nothing, though its answer is unread', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Answer A.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  rig.port.shown = false;
  rig.registry.show(rig.conv);
  await rig.conv.send('question A');
  await rig.idle(); // the answer came with nothing shown: unread
  expect(rig.conv.status).toBe('done');
  rig.registry.park(rig.conv); // not headless: nobody left it
  expect(finished(rig)).toEqual([]);
  expect(rig.registry.attention().done).toBe(1);
});

test('a session left at rest and already read says nothing', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Answer A.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const a = await answeredAndLeft(rig);
  expect(a.closed).toBe(true);
  expect(finished(rig)).toEqual([]);
  expect(rig.registry.attention().done).toBe(0);
});

test('a session left at rest whose answer came behind a cover is counted but not announced', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Answer A.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  rig.port.shown = false; // a picker or a pager covers the chat's end
  const a = await answeredAndLeft(rig);
  expect(a.closed).toBe(true);
  expect(finished(rig)).toEqual([]);
  expect(rig.registry.attention().done).toBe(1);
});

test('a session left that ends with no answer to read says nothing', async () => {
  const model = new ScriptedModel();
  const sub = model.when((req) => firstUser(req).includes('question A'));
  sub.script([{ hold: true }, { text: '' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  rig.registry.show(rig.conv);
  void rig.conv.send('question A');
  await rig.until(() => sub.held && rig.conv.sessionId !== '');
  const { left: a } = rig.switchTo();
  sub.release();
  await rig.until(() => a.closed);
  expect(a.status).toBe('idle');
  expect(finished(rig)).toEqual([]);
  expect(rig.registry.attention().done).toBe(0);
});

test('the exit parks nothing and says nothing', async () => {
  const { sub, rig } = await heldTurn();
  const { left: a } = rig.switchTo();
  rig.registry.closeAll('exit');
  sub.release();
  await tick(100);
  expect(a.closeReason).toBe('exit');
  expect(finished(rig)).toEqual([]);
  expect(rig.registry.attention().done).toBe(0);
});

test('a finish is not said when the park throws', async () => {
  const { sub, rig } = await heldTurn();
  const { left: a } = rig.switchTo();
  a.save = () => { throw new Error('disk full'); };
  sub.release();
  await rig.until(() => rig.log.some((l) => l.includes('disk full')));
  expect(finished(rig)).toEqual([]);
  a.save = () => {};
});

test('a left session\'s running turn counts as running until it ends; the one on screen never does', async () => {
  const { sub, rig } = await heldTurn();
  expect(rig.registry.leftRunning()).toBe(0); // on screen
  const { left: a } = rig.switchTo();
  expect(rig.registry.leftRunning()).toBe(1);
  expect(rig.registry.children.backgroundCount()).toBe(0); // the tasks' count is its own
  sub.release();
  await rig.until(() => a.closed);
  expect(rig.registry.leftRunning()).toBe(0);
});

test('a left turn that ends without the session being put away redraws', async () => {
  const { sub, rig } = await heldTurn();
  const { left: a } = rig.switchTo();
  // A task still counted keeps the session loaded when its own turn ends.
  const task = {} as Conversation;
  a.children.add(task);
  let heard = 0;
  rig.registry.onChange(() => { heard++; });
  sub.release();
  await rig.until(() => !a.busy);
  await tick(50);
  expect(a.closed).toBe(false);
  expect(rig.registry.leftRunning()).toBe(0);
  expect(heard).toBeGreaterThan(0);
  a.children.delete(task);
});

// A record that goes missing while the app runs: every turn's memory block says so, once.
const noteRows = (c: Conversation) => c.currentRows().filter((m) => m.role === 'note' && String(m.content).includes('is missing — no memory fact is sent'));

test('the missing-memory note is said once in a session left, and again on screen', async () => {
  const { memoryTrustPath } = await import('../assistant/memory-trust.ts');
  const model = new ScriptedModel();
  const sub = model.when((req) => firstUser(req).includes('question A'));
  sub.script([{ hold: true }, { text: 'A1.' }], [{ text: 'A2.' }], [{ text: 'A3.' }]);
  model.script([{ text: 'B1.' }], [{ text: 'B2.' }], [{ text: 'B3.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const record = fs.readFileSync(memoryTrustPath(), 'utf8');
  try {
    rig.registry.show(rig.conv);
    void rig.conv.send('question A');
    await rig.until(() => sub.held && rig.conv.sessionId !== '');
    fs.rmSync(memoryTrustPath()); // the record goes missing while the first turn runs
    rig.conv.enqueue('second A');
    rig.conv.toggleHoldLast();
    rig.conv.enqueue('third A');
    rig.conv.toggleHoldLast();
    const { left: a } = rig.switchTo();
    sub.release();
    await rig.until(() => a.closed, 15_000);
    // Two turns ran in the left session after the record went: one note there.
    expect(noteRows(a)).toHaveLength(1);
    const b = rig.conv;
    await b.send('question B');
    await rig.idle();
    expect(noteRows(b)).toHaveLength(1); // not spent where nobody reads
    await b.send('again B');
    await rig.idle();
    expect(noteRows(b)).toHaveLength(1);
  } finally {
    fs.writeFileSync(memoryTrustPath(), record);
  }
});

test('a left session whose unread thing is a task\'s result is counted but not announced (the result has its own toast)', async () => {
  const { sub, rig } = await heldTurn();
  const { left: a } = rig.switchTo();
  const task = {} as Conversation;
  a.children.add(task); // keeps it loaded when its own turn ends
  sub.release();
  await rig.until(() => !a.busy);
  a.deliver('job finished:\nok'); // lands as a row after the answer
  a.children.delete(task);
  a.emit({ type: 'children', count: 0 });
  await rig.until(() => a.closed);
  expect(rig.registry.attention().done).toBe(1);
  expect(finished(rig)).toEqual([]);
});
