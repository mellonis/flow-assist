// The live descendants of a conversation as data: the walk, the status of each, and the
// `tree` event that reaches the root (AGENTS.md (agent tree)).
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rigOf = (model: ScriptedModel) => conversationRig(model, { ai: { backgroundFollowUp: false } });

// A child of `from` whose run is begun, not awaited (`run: false`: only started).
function begin(rig: Rig, s: ChildSpec, from: Conversation = rig.conv, run = true) {
  const id = rig.conv.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const started = from.startChild(s, id);
  if ('refused' in started) throw new Error(`refused: ${started.refused}`);
  children.push(started.child);
  return { child: started.child, done: run ? started.run() : Promise.resolve(null) };
}
// Counts what the root hears and the host's redraws.
function spy(rig: Rig) {
  const seen = { tree: 0, notify: 0 };
  rig.conv.on('tree', () => { seen.tree++; });
  (rig.conv.deps as { notify: () => void }).notify = () => { seen.notify++; };
  return seen;
}

test('the tree walks depth first, children in start order, with the live count below each', async () => {
  const model = new ScriptedModel();
  subScript(model, 'outer job').script([{ hold: true }], [{ text: 'outer' }]);
  subScript(model, 'inner job').script([{ hold: true }], [{ text: 'inner' }]);
  subScript(model, 'other job').script([{ hold: true }], [{ text: 'other' }]);
  const rig = rigOf(model);
  const outer = begin(rig, spec('outer', 'outer job'));
  const inner = begin(rig, spec('inner', 'inner job'), outer.child);
  const other = begin(rig, spec('other', 'other job', { kind: 'task' }));
  await rig.until(() => rig.conv.tree().every((n) => n.status === 'working') && rig.conv.tree().length === 3);
  expect(rig.conv.tree().map((n) => [n.label, n.kind, n.depth, n.below])).toEqual([
    ['outer', 'subagent', 1, 1], ['inner', 'subagent', 2, 0], ['other', 'task', 1, 0],
  ]);
  expect(rig.conv.nodeByKey(inner.child.key)).toBe(inner.child);
  expect(outer.child.tree().map((n) => n.label)).toEqual(['inner']);
  expect(rig.conv.nodeByKey('nope')).toBeNull();
  for (const c of [outer, inner, other]) c.child.stopSubtree('');
  await Promise.all([outer.done, inner.done, other.done]);
  expect(rig.conv.tree()).toEqual([]);
  expect(rig.conv.nodeByKey(inner.child.key)).toBeNull();
});

test('each status: working with its latest step, waiting on a y/n, queued, delayed', async () => {
  const model = new ScriptedModel();
  subScript(model, 'work job').script([{ hold: true }], [{ text: 'w' }]);
  subScript(model, 'ask job').script([{ tool: 'run_command', args: { command: 'echo x > a.txt' } }], [{ text: 'a' }]);
  const rig = rigOf(model);
  const w = begin(rig, spec('work', 'work job'));
  const a = begin(rig, spec('ask', 'ask job'));
  const q = begin(rig, spec('queue', 'never'), rig.conv, false);
  const id = rig.conv.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const d = scheduleChild(spec('later', 'never', { kind: 'task' }), 180_000, { startChild: (sp) => rig.conv.startChild(sp, id), slots: rig.registry.children, notify: () => {} });
  if ('refused' in d) throw new Error(d.refused);
  children.push(d.child);
  await rig.until(() => a.child.confirm !== null && w.child.busy);
  const byLabel = Object.fromEntries(rig.conv.tree().map((n) => [n.label, n]));
  expect(byLabel.work).toMatchObject({ status: 'working', latest: w.child.toolLabel || w.child.verb });
  expect(byLabel.work!.startedAt).not.toBeNull();
  expect(byLabel.ask).toMatchObject({ status: 'waiting', latest: '' });
  expect(byLabel.queue).toMatchObject({ status: 'queued', startedAt: null, until: null });
  expect(byLabel.later!.status).toBe('delayed');
  expect(byLabel.later!.until).toBeGreaterThan(Date.now());
  // The listing and the tree cannot disagree.
  expect(rig.conv.runningChildren().map((r) => [r.label, r.status])).toEqual(rig.conv.tree().map((n) => [n.label, n.status]));
  w.child.setToolLabel('⚙ read_file(src/a.ts)…');
  expect(rig.conv.tree().find((n) => n.label === 'work')!.latest).toBe('⚙ read_file(src/a.ts)…');
  for (const c of [w, a, q]) c.child.stopSubtree('');
  d.child.stopSubtree('');
  await Promise.all([w.done, a.done]);
});

test('a node handed up to the session when its parent ends appears at depth 1', async () => {
  const model = new ScriptedModel();
  subScript(model, 'outer job').script([{ text: 'outer is over' }]);
  const innerScript = subScript(model, 'inner job');
  innerScript.script([{ hold: true }], [{ text: 'inner' }]);
  const rig = rigOf(model);
  const outer = begin(rig, spec('outer', 'outer job'));
  const inner = begin(rig, spec('inner', 'inner job'), outer.child);
  await rig.until(() => innerScript.held);
  await outer.done;
  expect(rig.conv.tree().map((n) => [n.label, n.depth])).toEqual([['inner', 1]]);
  innerScript.release();
  await inner.done;
  expect(rig.conv.tree()).toEqual([]);
});

test('a change in a grandchild reaches the root once, with one redraw', async () => {
  const model = new ScriptedModel();
  const rig = rigOf(model);
  const outer = begin(rig, spec('outer', 'o'), rig.conv, false);
  const seen = spy(rig);
  const heard: string[] = [];
  outer.child.on('tree', () => { heard.push('outer'); });
  begin(rig, spec('inner', 'i'), outer.child, false);
  expect(heard).toEqual(['outer']);
  expect(seen).toEqual({ tree: 1, notify: 1 });
  // A busy flip of the grandchild is told at once as well.
  const inner = outer.child.nodeByKey(rig.conv.tree()[1]!.key)!;
  inner.busy = true;
  expect(seen).toEqual({ tree: 2, notify: 2 });
  inner.busy = true;
  expect(seen).toEqual({ tree: 2, notify: 2 });
});

test('a y/n parked or answered below tells the root, and so does a delay that ends', async () => {
  const model = new ScriptedModel();
  subScript(model, 'ask job').script([{ tool: 'run_command', args: { command: 'echo x > b.txt' } }], [{ text: 'a' }]);
  const rig = rigOf(model);
  const seen = spy(rig);
  const a = begin(rig, spec('ask', 'ask job'));
  await rig.until(() => a.child.confirm !== null);
  expect(rig.conv.tree()[0]!.status).toBe('waiting');
  const parked = seen.tree;
  a.child.answerConfirm(false);
  expect(seen.tree).toBeGreaterThan(parked);
  await a.done;
  const id = rig.conv.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const delayed = rig.conv.startChild(spec('later', 'x', { kind: 'task' }), id);
  if ('refused' in delayed) throw new Error(delayed.refused);
  children.push(delayed.child);
  delayed.armed(setTimeout(() => {}, 1));
  const before = seen.tree;
  expect(rig.conv.tree().find((n) => n.label === 'later')!.status).toBe('delayed');
  delayed.fired();
  expect(seen.tree).toBe(before + 1);
  expect(rig.conv.tree().find((n) => n.label === 'later')!.status).toBe('queued');
});

test('a change of the latest step is held to one tree per 200 ms; a status change is not', async () => {
  const rig = rigOf(new ScriptedModel());
  const { child } = begin(rig, spec('kid', 'k'), rig.conv, false);
  const seen = spy(rig);
  child.setToolLabel('⚙ one…');
  expect(seen.tree).toBe(1);
  child.setToolLabel('⚙ two…');
  child.setToolLabel('⚙ three…');
  expect(seen.tree).toBe(1);
  child.busy = true;
  expect(seen.tree).toBe(2);
  await wait(260);
  expect(seen).toEqual({ tree: 3, notify: 3 });
  expect(rig.conv.tree()[0]!.latest).toBe('⚙ three…');
  // Quiet again: the window ends with nothing held, and the next change goes at once.
  await wait(260);
  expect(seen.tree).toBe(3);
  child.setToolLabel('⚙ four…');
  expect(seen.tree).toBe(4);
});

test('a root closed inside the hold tells nobody afterwards and keeps no timer', async () => {
  const rig = rigOf(new ScriptedModel());
  const { child } = begin(rig, spec('kid', 'k'), rig.conv, false);
  const seen = spy(rig);
  child.setToolLabel('⚙ one…');
  child.setToolLabel('⚙ two…');
  expect(seen).toEqual({ tree: 1, notify: 1 });
  expect((rig.conv as unknown as { treeHold: unknown }).treeHold).not.toBeNull();
  rig.conv.close('exit');
  expect((rig.conv as unknown as { treeHold: unknown }).treeHold).toBeNull();
  await wait(260);
  expect(seen.notify).toBe(1);
  child.setToolLabel('⚙ three…');
  expect(seen.notify).toBe(1);
});
