// A child that may write parks its y/n like a session's, and the conversations above it
// know what to offer the person (AGENTS.md (a conversation starts a child)): the oldest
// request of the subtree, labelled by its path, one at a time; the answer goes to its
// owner; the settings-file guard never runs below a session.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
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
const made = (rig: Rig, file: string) => fs.existsSync(path.join(rig.root, file));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A child of `from` (the rig's conversation unless said), its lines going under the
// journal id of `from`'s session; its run is begun, not awaited.
function begin(rig: Rig, s: ChildSpec, from: Conversation = rig.conv) {
  const id = rig.conv.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const started = from.startChild(s, id);
  if ('refused' in started) throw new Error(`refused: ${started.refused}`);
  children.push(started.child);
  return { child: started.child, done: started.run() };
}
const answers = (rig: Rig, label: string) => rig.journal().filter((e) => e.t === 'confirm' && (e.subagent === label || e.task === label));

test('a subagent the person starts parks a write, the session offers it with the label, and a yes runs it', async () => {
  const model = new ScriptedModel();
  subScript(model, 'make a').script(write('a.txt'), [{ text: 'made it' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { child, done } = begin(rig, spec('maker', 'make a'));
  await rig.until(() => rig.conv.offered() !== null);
  const o = rig.conv.offered()!;
  expect(o.owner).toBe(child);
  expect(o.path).toEqual(['maker']);
  expect(o.request.name).toBe('run_command');
  expect(rig.conv.subtreeWaiting).toBe(true);
  expect(made(rig, 'a.txt')).toBe(false);
  o.owner.answerConfirm(true);
  expect(await done).toMatchObject({ outcome: 'answer', text: 'made it' });
  expect(made(rig, 'a.txt')).toBe(true);
  expect(answers(rig, 'maker')).toMatchObject([{ name: 'run_command', answer: 'yes', by: 'person', subagent: 'maker' }]);
  expect(rig.conv.offered()).toBeNull();
  expect(rig.conv.subtreeWaiting).toBe(false);
});

test('a no declines the write and the child\'s turn goes on', async () => {
  const model = new ScriptedModel();
  subScript(model, 'make b').script(write('b.txt'), [{ text: 'was refused' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { child, done } = begin(rig, spec('maker', 'make b'));
  await rig.until(() => rig.conv.offered() !== null);
  rig.conv.offered()!.owner.answerConfirm(false);
  expect(await done).toMatchObject({ outcome: 'answer', text: 'was refused' });
  expect(made(rig, 'b.txt')).toBe(false);
  expect(answers(rig, 'maker')).toMatchObject([{ answer: 'no', by: 'person' }]);
  expect(child.confirm).toBeNull();
});

test('two children waiting: the older is offered, and after its answer the other', async () => {
  const model = new ScriptedModel();
  subScript(model, 'first job').script(write('one.txt'), [{ text: 'one' }]);
  subScript(model, 'second job').script(write('two.txt'), [{ text: 'two' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const a = begin(rig, spec('first', 'first job'));
  await rig.until(() => rig.conv.offered()?.owner === a.child);
  const b = begin(rig, spec('second', 'second job'));
  await rig.until(() => b.child.confirm !== null);
  expect(rig.conv.offered()!.path).toEqual(['first']);
  rig.conv.offered()!.owner.answerConfirm(true);
  await a.done;
  expect(rig.conv.offered()!.path).toEqual(['second']);
  expect(rig.conv.offered()!.owner).toBe(b.child);
  rig.conv.offered()!.owner.answerConfirm(false);
  await b.done;
  expect(made(rig, 'one.txt')).toBe(true);
  expect(made(rig, 'two.txt')).toBe(false);
});

test('a grandchild\'s request carries both labels, and the answer goes to the grandchild', async () => {
  const model = new ScriptedModel();
  subScript(model, 'outer job').script([{ hold: true }], [{ text: 'outer' }]);
  subScript(model, 'inner job').script(write('deep.txt'), [{ text: 'inner' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const outer = begin(rig, spec('outer', 'outer job'));
  const inner = begin(rig, spec('inner', 'inner job'), outer.child);
  await rig.until(() => rig.conv.offered() !== null);
  const o = rig.conv.offered()!;
  expect(o.path).toEqual(['outer', 'inner']);
  expect(o.owner).toBe(inner.child);
  expect(outer.child.offered()!.path).toEqual(['inner']);
  expect(outer.child.confirm).toBeNull();
  o.owner.answerConfirm(true);
  await inner.done;
  expect(made(rig, 'deep.txt')).toBe(true);
});

test('the session\'s own request wins over a child\'s, which is not offered until the own one is answered', async () => {
  const model = new ScriptedModel();
  subScript(model, 'child job').script(write('c.txt'), [{ text: 'c' }]);
  model.script(write('own.txt'), [{ text: 'own done' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const c = begin(rig, spec('kid', 'child job'));
  await rig.until(() => c.child.confirm !== null);
  const turn = rig.conv.send('write own');
  await rig.until(() => rig.conv.confirm !== null);
  const o = rig.conv.offered()!;
  expect(o.owner).toBe(rig.conv);
  expect(o.path).toEqual([]);
  expect(rig.conv.subtreeWaiting).toBe(true);
  o.owner.answerConfirm(true);
  await turn;
  expect(made(rig, 'own.txt')).toBe(true);
  expect(c.child.confirm).not.toBeNull();
  expect(rig.conv.offered()!.owner).toBe(c.child);
  c.child.answerConfirm(false);
  await c.done;
});

test('a grandchild handed up to the session asks, and the session offers it where it now belongs', async () => {
  const model = new ScriptedModel();
  subScript(model, 'outer job').script([{ text: 'outer is over' }]);
  const innerScript = subScript(model, 'inner job');
  innerScript.script([{ hold: true }, { tool: 'run_command', args: { command: 'echo x > up.txt' } }], [{ text: 'inner' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const heard: string[] = [];
  let notified = 0;
  rig.conv.on('asking', () => { heard.push('asking'); });
  (rig.conv.deps as { notify: () => void }).notify = () => { notified++; };
  const outer = begin(rig, spec('outer', 'outer job'));
  const inner = begin(rig, spec('inner', 'inner job'), outer.child);
  await rig.until(() => innerScript.held);
  await outer.done;
  // The conversation that started it is over: it is not told, the session is.
  const toldOuter: string[] = [];
  const emitOuter = outer.child.emit.bind(outer.child);
  outer.child.emit = (ev) => { toldOuter.push(ev.type); emitOuter(ev); };
  expect(inner.child.parent).toBe(rig.conv);
  const before = notified;
  innerScript.release();
  await rig.until(() => inner.child.confirm !== null);
  expect(heard).toEqual(['asking']);
  expect(toldOuter).toEqual([]);
  expect(notified).toBeGreaterThan(before);
  expect(rig.conv.offered()).toMatchObject({ owner: inner.child, path: ['inner'] });
  rig.conv.offered()!.owner.answerConfirm(true);
  await inner.done;
  expect(heard).toEqual(['asking', 'asking']);
  expect(made(rig, 'up.txt')).toBe(true);
});

test('a clear declines every request in the subtree by `reset`, and a stop declines its child\'s by `stop` and delivers the result once', async () => {
  const model = new ScriptedModel();
  subScript(model, 'job a').script(write('x.txt'), [{ text: 'a' }]);
  subScript(model, 'job b').script(write('y.txt'), [{ text: 'half of b' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  const sessionRows = () => rig.conv.rows().filter((m) => m.role === 'bg').map((m) => String(m.content));
  const b = begin(rig, spec('bee', 'job b'));
  await rig.until(() => b.child.confirm !== null);
  expect(b.child.stopSubtree('')).toBe(true);
  await b.done;
  expect(answers(rig, 'bee')).toMatchObject([{ answer: 'no', by: 'stop' }]);
  expect(made(rig, 'y.txt')).toBe(false);
  await rig.until(() => sessionRows().length === 1);
  await wait(30);
  expect(sessionRows()).toHaveLength(1);
  expect(rig.conv.offered()).toBeNull();
  const a = begin(rig, spec('ay', 'job a'));
  await rig.until(() => a.child.confirm !== null);
  rig.conv.close('clear');
  await a.done;
  expect(answers(rig, 'ay')).toMatchObject([{ answer: 'no', by: 'reset' }]);
  expect(made(rig, 'x.txt')).toBe(false);
});

test('a parent\'s stop of a waiting grandchild declines it by `reset`, and the exit leaves a request as it is', async () => {
  const model = new ScriptedModel();
  subScript(model, 'outer job').script([{ hold: true }], [{ text: 'outer' }]);
  subScript(model, 'inner job').script(write('z.txt'), [{ text: 'inner' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const outer = begin(rig, spec('outer', 'outer job'));
  const inner = begin(rig, spec('inner', 'inner job'), outer.child);
  await rig.until(() => inner.child.confirm !== null);
  outer.child.stopSubtree('');
  await inner.done;
  expect(answers(rig, 'inner')).toMatchObject([{ answer: 'no', by: 'reset' }]);
  await outer.done;

  const model2 = new ScriptedModel();
  subScript(model2, 'at exit').script(write('e.txt'), [{ text: 'never' }]);
  const rig2 = conversationRig(model2, { ai: { backgroundFollowUp: false } });
  const e = begin(rig2, spec('exit', 'at exit'));
  await rig2.until(() => e.child.confirm !== null);
  e.child.close('exit');
  expect(e.child.confirm).not.toBeNull();
  expect(answers(rig2, 'exit')).toEqual([]);
});

test('a subagent\'s own auto mode `all` answers by `auto` and parks nothing', async () => {
  const model = new ScriptedModel();
  subScript(model, 'auto job').script(write('auto.txt'), [{ text: 'auto done' }]);
  const rig = conversationRig(model, { shell: { autoRun: true }, ai: { backgroundFollowUp: false } });
  const { child, done } = begin(rig, spec('auto', 'auto job'));
  child.setAutoMode('all');
  expect(await done).toMatchObject({ outcome: 'answer', text: 'auto done' });
  expect(made(rig, 'auto.txt')).toBe(true);
  expect(answers(rig, 'auto')).toMatchObject([{ answer: 'yes', by: 'auto', subagent: 'auto' }]);
  expect(rig.conv.offered()).toBeNull();
});

test('a read-only child parks nothing: a model\'s subagent and a task decline, journaled `background`', async () => {
  const model = new ScriptedModel();
  subScript(model, 'model job').script(write('m.txt'), [{ text: 'm' }]);
  model.script(write('t.txt'), [{ text: 't' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const m = begin(rig, spec('model-sub', 'model job', { by: 'model' }));
  expect(await m.done).toMatchObject({ outcome: 'answer' });
  expect(answers(rig, 'model-sub')).toMatchObject([{ answer: 'no', by: 'background' }]);
  const t = begin(rig, { kind: 'task', label: 'plain', prompt: 'write it', by: 'model' });
  expect(await t.done).toMatchObject({ outcome: 'answer' });
  expect(answers(rig, 'plain')).toMatchObject([{ answer: 'no', by: 'background', task: 'plain' }]);
  expect(made(rig, 'm.txt')).toBe(false);
  expect(made(rig, 't.txt')).toBe(false);
  expect(rig.conv.offered()).toBeNull();
});

test('a task with `write: true` asks, tagged `task`; where the host cannot ask it declines', async () => {
  const model = new ScriptedModel();
  model.script(write('w.txt'), [{ text: 'w' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const w = begin(rig, { kind: 'task', label: 'wr', prompt: 'write it', by: 'model', write: true });
  await rig.until(() => rig.conv.offered() !== null);
  expect(rig.conv.offered()).toMatchObject({ owner: w.child, path: ['wr'] });
  w.child.answerConfirm(true);
  await w.done;
  expect(answers(rig, 'wr')).toMatchObject([{ answer: 'yes', by: 'person', task: 'wr' }]);

  const model2 = new ScriptedModel();
  subScript(model2, 'no host').script(write('n.txt'), [{ text: 'n' }]);
  const rig2 = conversationRig(model2, { canAsk: false, policy: { kind: 'none' }, ai: { backgroundFollowUp: false } });
  const n = begin(rig2, spec('nobody', 'no host'));
  expect(n.child.policy.kind).toBe('always-no');
  expect(await n.done).toMatchObject({ outcome: 'answer' });
  expect(made(rig2, 'n.txt')).toBe(false);
});

test('no settings y/n is ever parked in a child: the guard is not checked there', async () => {
  const model = new ScriptedModel();
  subScript(model, 'noon').script([{ tool: 'datetime', args: {} }], [{ text: 'done' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  let checked = 0;
  (rig.services as unknown as Record<string, unknown>).configChanges = {
    check: () => { checked++; return [{ path: '/x/config.json', file: 'config.json', hash: 'h', lines: ['ai.model'] }]; },
    apply: () => ({ applied: [], restart: [] }), decline: () => null,
  };
  const { child, done } = begin(rig, spec('g', 'noon'));
  let ended = false;
  void done.then(() => { ended = true; });
  await rig.until(() => ended || child.confirm !== null);
  expect(child.confirm).toBeNull();
  expect(child.configAsk).toBeNull();
  expect(checked).toBe(0);
});

test('scheduled through the host\'s slots, a subagent that waits still settles once answered', async () => {
  const model = new ScriptedModel();
  subScript(model, 'slot job').script(write('s.txt'), [{ text: 'slotted' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const id = rig.conv.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const r = scheduleChild(spec('slot', 'slot job'), 0, { startChild: (sp) => rig.conv.startChild(sp, id), slots: rig.registry.children, showMessage: rig.services.showMessage, pushLog: rig.services.pushLog });
  if ('refused' in r) throw new Error(r.refused);
  children.push(r.child);
  await rig.until(() => rig.conv.offered() !== null);
  rig.conv.offered()!.owner.answerConfirm(true);
  await rig.until(() => rig.registry.children.backgroundCount() === 0);
  expect(made(rig, 's.txt')).toBe(true);
});
