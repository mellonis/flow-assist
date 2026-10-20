// A subagent the person started stays after its answer: idle between turns, holding no slot,
// ended only by a stop, a /clear or the exit (AGENTS.md (a conversation starts a child)).
// A task, and a subagent the model started, end after their answer.
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
const spec = (label: string, prompt: string, over: Partial<ChildSpec> = {}): ChildSpec => ({ kind: 'subagent', label, prompt, by: 'person', ...over });
const bgRows = (c: Conversation): string[] => c.rows().filter((m) => m.role === 'bg').map((m) => String(m.content));
const system0 = (model: ScriptedModel, at: number): string => system(model.requests[at]!);

// The child, scheduled through the host's slots with no delay, as a slash command does it.
function scheduled(rig: Rig, s: ChildSpec, from: Conversation = rig.conv) {
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
const lines = (rig: Rig) => rig.journal().filter((e) => e.t === 'subagent');
const noFollowUp = { ai: { backgroundFollowUp: false } };

test('a subagent the person started is idle after its answer: counted, not closed, its first answer the session\'s', async () => {
  const model = new ScriptedModel();
  subScript(model, 'stay').script([{ text: 'first answer' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const child = scheduled(rig, spec('stayer', 'stay'));
  await rig.until(() => bgRows(rig.conv).length === 1);
  await quiet(rig);
  expect(bgRows(rig.conv)).toEqual(['stayer finished:\nfirst answer']);
  expect(child.closed).toBe(false);
  expect(child.idle).toBe(true);
  expect(rig.conv.children.size).toBe(1);
  expect(rig.conv.runningChildren()).toMatchObject([{ label: 'stayer', kind: 'subagent', status: 'idle' }]);
  expect(rig.conv.tree()).toMatchObject([{ label: 'stayer', status: 'idle', depth: 1 }]);
  // Nothing of it is in the ended list yet, and the parent's journal has no end line.
  expect(rig.conv.endedChildren).toEqual([]);
  expect(lines(rig).map((e) => e.event)).toEqual(['start', 'answered']);
  expect(lines(rig)[1]).toMatchObject({ label: 'stayer', outcome: 'answer', id: child.subJournalId });
});

test('a task, and a subagent the model started, end after their answer', async () => {
  const model = new ScriptedModel();
  model.when((req) => system(req).includes('Task: a task')).script([{ text: 'task answer' }]);
  subScript(model, 'by model').script([{ text: 'model answer' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const task = scheduled(rig, { kind: 'task', label: 't', prompt: 'a task', by: 'model' });
  const byModel = scheduled(rig, spec('m', 'by model', { by: 'model' }));
  await rig.until(() => bgRows(rig.conv).length === 2);
  await quiet(rig);
  expect(task.closed).toBe(true);
  expect(byModel.closed).toBe(true);
  expect(rig.conv.children.size).toBe(0);
  expect(rig.conv.endedChildren.map((e) => [e.label, e.outcome])).toEqual(expect.arrayContaining([['t', 'answer'], ['m', 'answer']]));
  expect(lines(rig).map((e) => e.event)).toEqual(['start', 'end']);
});

test('an idle subagent holds no slot: the only free slot goes to another child at once', async () => {
  const model = new ScriptedModel();
  subScript(model, 'idler').script([{ text: 'idle now' }]);
  const blocker = subScript(model, 'blocker');
  blocker.script([{ hold: true }, { text: 'blocked' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp, extra: { sessions: { maxRunning: 2 } } });
  const idler = scheduled(rig, spec('idler', 'idler'));
  await rig.until(() => idler.idle);
  await quiet(rig);
  expect(rig.registry.children.running()).toBe(0);
  scheduled(rig, spec('blocker', 'blocker', { by: 'model' }));
  await rig.until(() => blocker.held);
  expect(rig.registry.children.running()).toBe(1);
  expect(rig.conv.runningChildren().map((c) => [c.label, c.status])).toEqual([['idler', 'idle'], ['blocker', 'working']]);
  blocker.release();
  await quiet(rig);
});

test('a message to an idle subagent starts a turn that takes a slot like any child: queued while none is free', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'idler');
  sub.script([{ text: 'one' }], [{ text: 'two' }]);
  const blocker = subScript(model, 'blocker');
  blocker.script([{ hold: true }, { text: 'blocked' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp, extra: { sessions: { maxRunning: 2 } } });
  const idler = scheduled(rig, spec('idler', 'idler'));
  await rig.until(() => idler.idle);
  await quiet(rig);
  scheduled(rig, spec('blocker', 'blocker', { by: 'model' }));
  await rig.until(() => blocker.held);
  expect(idler.receive('and now?')).toEqual({ sent: 'started' });
  // It waits for the slot: not idle, not working.
  expect(idler.idle).toBe(false);
  expect(rig.conv.runningChildren().find((c) => c.label === 'idler')).toMatchObject({ status: 'queued' });
  expect(sub.requests).toHaveLength(1);
  blocker.release();
  await rig.until(() => sub.requests.length === 2);
  await rig.until(() => idler.idle);
  await quiet(rig);
  expect(idler.lastAnswer()).toBe('two');
});

test('a later answer goes to no conversation: the row says answered until it is read, and the parent\'s journal says each answer', async () => {
  const model = new ScriptedModel();
  subScript(model, 'talker').script([{ text: 'first' }], [{ text: 'second' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const child = scheduled(rig, spec('talker', 'talker'));
  await rig.until(() => child.idle);
  await quiet(rig);
  // The first answer is delivered and is not marked: it is in the session already.
  expect(rig.conv.tree()[0]!.answered).toBeUndefined();
  expect(child.receive('again please')).toEqual({ sent: 'started' });
  await rig.until(() => child.idle && child.lastAnswer() === 'second');
  await quiet(rig);
  expect(bgRows(rig.conv)).toEqual(['talker finished:\nfirst']);
  expect(rig.conv.inbox).toEqual([]);
  expect(rig.conv.tree()).toMatchObject([{ label: 'talker', status: 'idle', answered: true }]);
  expect(rig.conv.runningChildren()[0]).toMatchObject({ status: 'idle', answered: true });
  child.seeAnswer();
  expect(rig.conv.tree()[0]!.answered).toBeUndefined();
  expect(lines(rig).map((e) => e.event)).toEqual(['start', 'answered', 'answered']);
  expect(child.closed).toBe(false);
});

test('an answer that lands while nobody has read the previous one keeps the row answered; a read clears it for good', async () => {
  const model = new ScriptedModel();
  subScript(model, 'twice').script([{ text: 'a' }], [{ text: 'b' }], [{ text: 'c' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const child = scheduled(rig, spec('twice', 'twice'));
  await rig.until(() => child.idle);
  await quiet(rig);
  child.receive('b?');
  await rig.until(() => child.idle && child.lastAnswer() === 'b');
  await quiet(rig);
  child.seeAnswer();
  child.receive('c?');
  await rig.until(() => child.idle && child.lastAnswer() === 'c');
  await quiet(rig);
  expect(rig.conv.tree()[0]!.answered).toBe(true);
});

test('the system prompt of every turn carries the original task, never a later message', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'ORIGINAL TASK');
  sub.script([{ text: 'one' }], [{ text: 'two' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const child = scheduled(rig, spec('keeper', 'ORIGINAL TASK'));
  await rig.until(() => child.idle);
  await quiet(rig);
  child.receive('something quite different');
  await rig.until(() => sub.requests.length === 2);
  await rig.until(() => child.idle);
  expect(system0(model, 1)).toContain("The person's task: ORIGINAL TASK");
  expect(system0(model, 1)).not.toContain('something quite different');
  // The message itself is an ordinary turn of the person in its history.
  expect(rig.sent(-1).at(-1)).toEqual({ role: 'user', content: 'something quite different' });
});

test('an idle subagent does not hold a session\'s park; one with a task running below it does', async () => {
  const model = new ScriptedModel();
  subScript(model, 'rest').script([{ text: 'resting' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const child = scheduled(rig, spec('rester', 'rest'));
  await rig.until(() => child.idle);
  await quiet(rig);
  expect(rig.registry.quiescent(rig.conv)).toBe(true);
  expect(rig.registry.statusOf(rig.conv.sessionId)).not.toBe('working');
  // A task it started is still at work: the session is not at rest.
  const below = scheduled(rig, { kind: 'task', label: 'below', prompt: 'wait here', by: 'model' }, child);
  expect(rig.registry.quiescent(rig.conv)).toBe(false);
  expect(rig.registry.statusOf(rig.conv.sessionId)).toBe('working');
  below.stopSubtree('');
  await quiet(rig);
});

test('a session left with an idle subagent is put away, and the exit writes the subagent\'s end', async () => {
  const model = new ScriptedModel();
  subScript(model, 'leave').script([{ text: 'left alone' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const first = rig.conv;
  const child = scheduled(rig, spec('leaver', 'leave'));
  await rig.until(() => child.idle);
  await quiet(rig);
  const id = first.sessionId;
  expect(rig.switchTo().outcome).toBe('parked');
  expect(first.closed).toBe(true);
  // It stays in memory, still idle, until the exit.
  expect(child.closed).toBe(false);
  rig.registry.closeAll('exit');
  expect(child.closed).toBe(true);
  expect(rig.journal(id).filter((e) => e.t === 'subagent' && e.event === 'end')).toMatchObject([{ label: 'leaver', outcome: 'stopped', stoppedBy: 'exit' }]);
});

test('a stop ends an idle subagent: closed, its row gone, one end line, its file closed once', async () => {
  const model = new ScriptedModel();
  subScript(model, 'halt').script([{ text: 'halted?' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const child = scheduled(rig, spec('halter', 'halt'));
  await rig.until(() => child.idle);
  await quiet(rig);
  expect(child.stopSubtree('x')).toBe(true);
  expect(child.closed).toBe(true);
  expect(rig.conv.children.size).toBe(0);
  expect(rig.conv.tree()).toEqual([]);
  expect(rig.conv.endedChildren.map((e) => [e.label, e.outcome])).toEqual([['halter', 'stopped']]);
  expect(lines(rig).map((e) => e.event)).toEqual(['start', 'answered', 'end']);
  expect(lines(rig).at(-1)).toMatchObject({ label: 'halter', outcome: 'stopped', stoppedBy: 'person', id: child.subJournalId });
  // The file closes with one `end` naming the stop, after the turn's own.
  const file = rig.subJournal('halter');
  expect(file.filter((e) => e.t === 'end' && e.stopped === 'person')).toHaveLength(1);
  expect(file.at(-1)).toMatchObject({ t: 'end', stopped: 'person' });
  // A second stop finds nothing.
  expect(child.stopSubtree('x')).toBe(false);
  expect(child.receive('hello?')).toEqual({ refused: 'halter has stopped' });
});

test('a /clear ends an idle subagent with the clear named in its end line', async () => {
  const model = new ScriptedModel();
  subScript(model, 'wipe').script([{ text: 'done' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const first = rig.conv;
  const child = scheduled(rig, spec('wiper', 'wipe'));
  await rig.until(() => child.idle);
  await quiet(rig);
  const id = first.sessionId;
  first.close('clear');
  expect(child.closed).toBe(true);
  expect(rig.journal(id).filter((e) => e.t === 'subagent' && e.event === 'end')).toMatchObject([{ label: 'wiper', outcome: 'stopped', stoppedBy: 'clear' }]);
});

test('an exit ends an idle subagent synchronously, like a running one', async () => {
  const model = new ScriptedModel();
  subScript(model, 'bye').script([{ text: 'bye' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const child = scheduled(rig, spec('goer', 'bye'));
  await rig.until(() => child.idle);
  await quiet(rig);
  rig.registry.closeAll('exit');
  expect(child.closed).toBe(true);
  expect(rig.journal().filter((e) => e.t === 'subagent' && e.event === 'end')).toMatchObject([{ label: 'goer', outcome: 'stopped', stoppedBy: 'exit' }]);
});

test('a stop of a working later turn ends the subagent: the turn is aborted, its end line says the person stopped it, and nothing is delivered', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'cut');
  sub.script([{ text: 'first' }], [{ text: 'half' }, { hold: true }, { text: 'never' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const child = scheduled(rig, spec('cutter', 'cut'));
  await rig.until(() => child.idle);
  await quiet(rig);
  child.receive('go on');
  await rig.until(() => sub.held);
  expect(child.stopSubtree('x')).toBe(true);
  await rig.until(() => child.closed);
  await quiet(rig);
  expect(bgRows(rig.conv)).toEqual(['cutter finished:\nfirst']);
  expect(rig.conv.children.size).toBe(0);
  expect(lines(rig).map((e) => e.event)).toEqual(['start', 'answered', 'end']);
  expect(lines(rig).at(-1)).toMatchObject({ outcome: 'stopped', stoppedBy: 'person' });
});

test('a stop of a queued later turn ends the subagent without sending it', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'queued');
  sub.script([{ text: 'one' }], [{ text: 'never sent' }]);
  const blocker = subScript(model, 'blocker');
  blocker.script([{ hold: true }, { text: 'blocked' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp, extra: { sessions: { maxRunning: 2 } } });
  const child = scheduled(rig, spec('queued', 'queued'));
  await rig.until(() => child.idle);
  await quiet(rig);
  scheduled(rig, spec('blocker', 'blocker', { by: 'model' }));
  await rig.until(() => blocker.held);
  child.receive('more');
  expect(child.stopSubtree('x')).toBe(true);
  await rig.until(() => child.closed);
  expect(sub.requests).toHaveLength(1);
  expect(lines(rig).filter((e) => e.label === 'queued').map((e) => e.event)).toEqual(['start', 'answered', 'end']);
  blocker.release();
  await quiet(rig);
});

test('a turn of a closed conversation is refused: nothing is sent', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'should not be asked' }]);
  const rig = conversationRig(model, noFollowUp);
  const conv = rig.conv;
  conv.close('exit');
  expect(await conv.send('hello')).toBe(false);
  expect(model.requests).toHaveLength(0);
});

test('a message to a task, or to a subagent the model started, is refused; an empty one too', async () => {
  const model = new ScriptedModel();
  subScript(model, 'm').script([{ text: 'm' }]);
  model.when((req) => system(req).includes('Task: tk')).script([{ text: 'tk' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const task = scheduled(rig, { kind: 'task', label: 'tk', prompt: 'tk', by: 'model' });
  const byModel = scheduled(rig, spec('m', 'm', { by: 'model' }));
  const own = scheduled(rig, spec('own', 'x'));
  await quiet(rig);
  expect(task.receive('hi')).toMatchObject({ refused: expect.stringContaining('takes no messages') });
  expect(byModel.receive('hi')).toMatchObject({ refused: expect.stringContaining('takes no messages') });
  expect(own.receive('   ')).toEqual({ refused: 'nothing to send' });
});

test('a message to a working subagent is queued and reaches it at its next step', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'steps');
  sub.script([{ hold: true }, { tool: 'datetime', args: {} }], [{ text: 'saw it' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const child = scheduled(rig, spec('steps', 'steps'));
  await rig.until(() => sub.held);
  expect(child.receive('also mind this')).toEqual({ sent: 'queued' });
  expect(child.queue.map((m) => m.text)).toEqual(['also mind this']);
  sub.release();
  await rig.until(() => child.idle);
  await quiet(rig);
  expect(child.queue).toEqual([]);
  expect(sub.requests).toHaveLength(2);
  expect(JSON.stringify(sub.requests[1]!.messages)).toContain('also mind this');
  // It reached the running turn: no turn of its own followed.
  expect(lines(rig).map((e) => e.event)).toEqual(['start', 'answered']);
});

test('a message that waits past the turn\'s last step starts the next turn through the schedule, one turn at a time', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'late');
  sub.script([{ hold: true }, { text: 'only' }], [{ hold: true }, { text: 'then this' }]);
  const rig = conversationRig(model, { inbox: true, ...noFollowUp });
  const child = scheduled(rig, spec('late', 'late'));
  await rig.until(() => sub.held);
  child.receive('afterwards');
  sub.release();
  // The next turn holds a slot of its own while it runs, and the subagent is not idle.
  await rig.until(() => sub.requests.length === 2 && sub.held);
  expect(rig.registry.children.running()).toBe(1);
  expect(child.idle).toBe(false);
  expect(rig.conv.runningChildren()[0]).toMatchObject({ status: 'working' });
  sub.release();
  await rig.until(() => child.idle);
  await quiet(rig);
  expect(child.lastAnswer()).toBe('then this');
  expect(lines(rig).map((e) => e.event)).toEqual(['start', 'answered', 'answered']);
  expect(bgRows(rig.conv)).toEqual(['late finished:\nonly']);
});
