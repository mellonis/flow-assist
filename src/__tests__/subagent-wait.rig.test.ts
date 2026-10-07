// A session whose subagent waits for the person says so, and a child that waits holds no
// slot (AGENTS.md (a host makes its conversations through one registry), AGENTS.md (a
// conversation starts a child of its own)).
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
const write = (file: string) => [{ tool: 'run_command', args: { command: `echo x > ${file}` } }];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A subagent of the session, scheduled through the host's slots with no delay.
function scheduled(rig: Rig, s: ChildSpec, from: Conversation = rig.conv) {
  const id = from.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const r = scheduleChild(s, 0, { startChild: (sp) => from.startChild(sp, id), slots: rig.registry.children, showMessage: rig.services.showMessage, pushLog: rig.services.pushLog });
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  children.push(r.child);
  return r.child;
}
// The alerts the host raised, by body.
function alerts(rig: Rig): string[] {
  const seen: string[] = [];
  (rig.services as unknown as { alert: (t: string, b?: string) => void }).alert = (_t, b) => { seen.push(b ?? ''); };
  return seen;
}
const counts = (rig: Rig) => ({ held: rig.registry.children.running(), waiting: rig.registry.children.waitingCount(), background: rig.registry.children.backgroundCount() });
const settledAll = (rig: Rig) => rig.until(() => rig.registry.children.backgroundCount() === 0, 5_000);
const bg = { ai: { backgroundFollowUp: false } };

test('a left session whose subagent asks is said once: a toast, an alert, the status `waiting`, the count; all gone after the answer', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job').script(write('a.txt'), [{ text: 'done' }]);
  const rig = conversationRig(model, bg);
  const said = alerts(rig);
  const session = rig.conv;
  session.title = 'Plan';
  rig.registry.show(session);
  const child = scheduled(rig, spec('maker', 'job'));
  await rig.until(() => child.confirm !== null);
  // Still on screen: nothing is said, and the registry owes the person nothing.
  expect(rig.toasts).toEqual([]);
  expect(rig.registry.attention().waiting).toBe(0);
  rig.switchTo();
  expect(rig.toasts).toEqual(['⏸ «Plan» waits for your answer — a y/n from maker']);
  expect(said).toEqual(['«Plan» waits for your answer — a y/n from maker']);
  expect(rig.registry.statusOf(session.sessionId)).toBe('waiting');
  expect(rig.registry.attention().waiting).toBe(1);
  session.offered()!.owner.answerConfirm(true);
  await settledAll(rig);
  expect(rig.registry.attention().waiting).toBe(0);
  expect(rig.registry.statusOf(session.sessionId)).not.toBe('waiting');
  expect(rig.toasts.filter((t) => t.startsWith('⏸'))).toHaveLength(1);
  expect(said).toHaveLength(1);
});

test('a session left while its subagent already waits says so at once; a second wait after the answer is said again', async () => {
  const model = new ScriptedModel();
  subScript(model, 'twice').script(write('one.txt'), write('two.txt'), [{ text: 'done' }]);
  const rig = conversationRig(model, bg);
  const said = alerts(rig);
  const session = rig.conv;
  const child = scheduled(rig, spec('twice', 'twice'));
  await rig.until(() => child.confirm !== null);
  rig.switchTo();
  expect(rig.toasts.filter((t) => t.startsWith('⏸'))).toEqual(['⏸ an untitled session waits for your answer — a y/n from twice']);
  child.answerConfirm(true);
  await rig.until(() => child.confirm !== null && child.confirm.args.includes('two.txt'));
  expect(rig.toasts.filter((t) => t.startsWith('⏸'))).toHaveLength(2);
  expect(said).toHaveLength(2);
  child.answerConfirm(true);
  await settledAll(rig);
  expect(rig.registry.attention().waiting).toBe(0);
});

test('two children below a left session are one wait: one toast, and the status holds until both are answered', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job a').script(write('a.txt'), [{ text: 'a' }]);
  subScript(model, 'job b').script(write('b.txt'), [{ text: 'b' }]);
  const rig = conversationRig(model, bg);
  const session = rig.conv;
  const a = scheduled(rig, spec('ay', 'job a'));
  const b = scheduled(rig, spec('bee', 'job b'));
  await rig.until(() => a.confirm !== null && b.confirm !== null);
  rig.switchTo();
  expect(rig.toasts.filter((t) => t.startsWith('⏸'))).toHaveLength(1);
  a.answerConfirm(false);
  await wait(20);
  expect(rig.registry.statusOf(session.sessionId)).toBe('waiting');
  expect(rig.registry.attention().waiting).toBe(1);
  b.answerConfirm(false);
  await settledAll(rig);
  expect(rig.registry.attention().waiting).toBe(0);
});

test('a session on screen never toasts about its own subtree, and the status still reads `waiting`', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job').script(write('s.txt'), [{ text: 'done' }]);
  const rig = conversationRig(model, bg);
  const said = alerts(rig);
  rig.registry.show(rig.conv);
  const child = scheduled(rig, spec('maker', 'job'));
  await rig.until(() => child.confirm !== null);
  await wait(20);
  expect(rig.toasts).toEqual([]);
  expect(said).toEqual([]);
  expect(rig.registry.statusOf(rig.conv.sessionId)).toBe('waiting');
  expect(rig.registry.attention()).toEqual({ waiting: 0, done: 0 });
  expect(rig.conv.runningChildren()).toMatchObject([{ label: 'maker', status: 'waiting' }]);
  child.answerConfirm(true);
  await settledAll(rig);
});

// ── the slots
test('three waiting subagents hold no slot: a fourth job runs, and each answered one goes on at once', async () => {
  const model = new ScriptedModel();
  for (const n of ['one', 'two', 'three']) subScript(model, `wait ${n}`).script(write(`${n}.txt`), [{ text: n }]);
  subScript(model, 'fourth').script([{ text: 'fourth ran' }]);
  const rig = conversationRig(model, bg);
  rig.registry.show(rig.conv);
  const waiting = ['one', 'two', 'three'].map((n) => scheduled(rig, spec(n, `wait ${n}`)));
  await rig.until(() => waiting.every((c) => c.confirm !== null));
  expect(counts(rig)).toEqual({ held: 0, waiting: 3, background: 3 });
  const fourth = scheduled(rig, spec('fourth', 'fourth', { by: 'model' }));
  await rig.until(() => fourth.closed);
  expect(rig.conv.endedChildren.map((e) => e.label)).toContain('fourth');
  expect(counts(rig)).toEqual({ held: 0, waiting: 3, background: 3 });
  for (const c of waiting) c.answerConfirm(true);
  expect(counts(rig)).toEqual({ held: 3, waiting: 0, background: 3 });
  await settledAll(rig);
  expect(counts(rig)).toEqual({ held: 0, waiting: 0, background: 0 });
});

test('a queued job starts when a child begins to wait, and an answered child stands over the limit until jobs end', async () => {
  const model = new ScriptedModel();
  const first = subScript(model, 'first');
  first.script([{ hold: true }, ...write('f.txt')], [{ text: 'first' }]);
  const second = subScript(model, 'second');
  second.script([{ hold: true }, { text: 'second' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false }, extra: { sessions: { maxRunning: 2 } } });
  rig.registry.show(rig.conv);
  // `maxRunning: 2` leaves one slot: the second job queues behind the first.
  const a = scheduled(rig, spec('first', 'first'));
  const b = scheduled(rig, spec('second', 'second', { by: 'model' }));
  await rig.until(() => first.held);
  await wait(30);
  expect(second.held).toBe(false);
  expect(rig.model.requests).toHaveLength(1);
  first.release();
  await rig.until(() => a.confirm !== null);
  // The first gave its slot up by parking its y/n, and the queue took it.
  await rig.until(() => second.held);
  expect(counts(rig)).toEqual({ held: 1, waiting: 1, background: 2 });
  const c = scheduled(rig, spec('third', 'third', { by: 'model' }));
  expect(counts(rig).background).toBe(3);
  a.answerConfirm(true);
  expect(counts(rig)).toEqual({ held: 2, waiting: 0, background: 3 });
  second.release();
  await settledAll(rig);
  expect(counts(rig)).toEqual({ held: 0, waiting: 0, background: 0 });
  expect(b.closed && c.closed).toBe(true);
});

test('a child that waits, is answered and waits again leaves the counts right each time', async () => {
  const model = new ScriptedModel();
  subScript(model, 'again').script(write('1.txt'), write('2.txt'), [{ text: 'done' }]);
  const rig = conversationRig(model, bg);
  const child = scheduled(rig, spec('again', 'again'));
  await rig.until(() => child.confirm !== null);
  expect(counts(rig)).toEqual({ held: 0, waiting: 1, background: 1 });
  child.answerConfirm(true);
  expect(counts(rig)).toEqual({ held: 1, waiting: 0, background: 1 });
  await rig.until(() => child.confirm !== null && child.confirm.args.includes('2.txt'));
  expect(counts(rig)).toEqual({ held: 0, waiting: 1, background: 1 });
  child.answerConfirm(false);
  await settledAll(rig);
  expect(counts(rig)).toEqual({ held: 0, waiting: 0, background: 0 });
});

test('a child stopped while it waits leaves the counts right and its request declined by `stop`', async () => {
  const model = new ScriptedModel();
  subScript(model, 'stoppable').script(write('s.txt'), [{ text: 'never' }]);
  const rig = conversationRig(model, bg);
  rig.registry.show(rig.conv);
  const child = scheduled(rig, spec('stoppable', 'stoppable'));
  await rig.until(() => child.confirm !== null);
  expect(counts(rig)).toEqual({ held: 0, waiting: 1, background: 1 });
  child.stopSubtree('');
  await settledAll(rig);
  expect(counts(rig)).toEqual({ held: 0, waiting: 0, background: 0 });
  expect(rig.journal().filter((e) => e.t === 'confirm')).toMatchObject([{ answer: 'no', by: 'stop' }]);
  expect(rig.conv.offered()).toBeNull();
});

test('children cleared while they wait leave the counts right; a child whose starter ended waits where it was handed', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job a').script(write('a.txt'), [{ text: 'a' }]);
  subScript(model, 'job b').script(write('b.txt'), [{ text: 'b' }]);
  const rig = conversationRig(model, bg);
  const a = scheduled(rig, spec('ay', 'job a'));
  const b = scheduled(rig, spec('bee', 'job b'));
  await rig.until(() => a.confirm !== null && b.confirm !== null);
  expect(counts(rig)).toEqual({ held: 0, waiting: 2, background: 2 });
  rig.conv.close('clear');
  await settledAll(rig);
  expect(counts(rig)).toEqual({ held: 0, waiting: 0, background: 0 });
  expect(rig.journal().filter((e) => e.t === 'confirm').map((e) => e.by)).toEqual(['reset', 'reset']);
});

test('a waiting grandchild, scheduled under a child, is counted the same way', async () => {
  const model = new ScriptedModel();
  subScript(model, 'outer job').script([{ hold: true }], [{ text: 'outer' }]);
  subScript(model, 'inner job').script(write('g.txt'), [{ text: 'inner' }]);
  const rig = conversationRig(model, bg);
  rig.registry.show(rig.conv);
  // The outer job may ask, so the job it starts may too.
  const outer = scheduled(rig, spec('outer', 'outer job', { by: 'model', write: true }));
  const inner = scheduled(rig, spec('inner', 'inner job'), outer);
  await rig.until(() => inner.confirm !== null);
  expect(counts(rig)).toMatchObject({ held: 1, waiting: 1 });
  expect(rig.conv.runningChildren()).toMatchObject([{ label: 'outer', status: 'working' }]);
  inner.answerConfirm(true);
  await rig.until(() => !inner.busy && inner.closed);
  outer.stopSubtree('');
  await settledAll(rig);
  expect(counts(rig)).toEqual({ held: 0, waiting: 0, background: 0 });
});
