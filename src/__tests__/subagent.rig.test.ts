// A subagent is a child conversation of its own kind (AGENTS.md (a conversation starts a
// child)): read-only, the config's limits, its own summary kept through a compaction, its
// calls and its start and end in the journal of the session that started it.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { scheduleChild } from '../assistant/child-schedule.ts';
import type { Conversation } from '../assistant/conversation.ts';
import type { ChildSpec } from '../assistant/conversation-types.ts';
import { exportMarkdown } from '../assistant/journal.ts';
import { addFact } from '../assistant/memory-store.ts';
import { memoryTrustPath } from '../assistant/memory-trust.ts';
import { workspaceFor } from '../assistant/workspace.ts';
import { ScriptedModel, handoff, type RecordedRequest } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';

const realFetch = globalThis.fetch;
const children: Conversation[] = [];
afterEach(() => { globalThis.fetch = realFetch; for (const c of children.splice(0)) c.close('exit'); closeRigs(); });

const system = (req: RecordedRequest): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
// The requests of a subagent whose task is `task`, apart from the rest.
const subScript = (model: ScriptedModel, task: string) => model.when((req) => system(req).includes(`The person's task: ${task}`) && (req as { stream?: boolean }).stream === true);
const spec = (label: string, prompt: string, over: Partial<ChildSpec> = {}): ChildSpec => ({ kind: 'subagent', label, prompt, by: 'person', ...over });
const bgRows = (c: Conversation): string[] => c.rows().filter((m) => m.role === 'bg').map((m) => String(m.content));
const rounds = (n: number) => Array.from({ length: n }, () => [{ tool: 'datetime', args: {} }]);

// A subagent of the rig's conversation, started as a slash command does: from the journal
// id of the conversation's own session, made if it has none.
function startFrom(rig: Rig, s: ChildSpec, from: Conversation = rig.conv) {
  const id = from.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const started = from.startChild(s, id);
  if ('refused' in started) throw new Error(`refused: ${started.refused}`);
  children.push(started.child);
  return { ...started, id };
}
// The same child, scheduled through the host's slots with no delay: the toast, the log,
// the slot.
function scheduled(rig: Rig, s: ChildSpec, from: Conversation = rig.conv, delayMs = 0) {
  const id = from.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const r = scheduleChild(s, delayMs, {
    startChild: (sp) => from.startChild(sp, id), slots: rig.registry.children,
    showMessage: rig.services.showMessage, pushLog: rig.services.pushLog, notify: () => {},
  });
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  children.push(r.child);
  return r.child;
}
const settled = (rig: Rig) => rig.until(() => rig.registry.children.backgroundCount() === 0, 5_000);

test('a subagent runs past twelve rounds: thirteen calls and an answer', async () => {
  const model = new ScriptedModel();
  model.script(...rounds(13), [{ text: 'all thirteen' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { run } = startFrom(rig, spec('long', 'keep going'));
  expect(await run()).toMatchObject({ outcome: 'answer', text: 'all thirteen' });
  expect(model.requests).toHaveLength(14);
});

test('a subagent stops at the config\'s round limit, not at twelve', async () => {
  const model = new ScriptedModel();
  model.script(...rounds(30));
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false, maxRounds: 15 } });
  const { run } = startFrom(rig, spec('capped', 'loop'));
  const r = await run();
  expect(r).toMatchObject({ outcome: 'limit', limit: { rounds: 15, lastStep: 'datetime {}' } });
  expect(model.requests).toHaveLength(15);
});

test('a subagent\'s request carries the framed task, the memory block and the language directive, and no screen tail', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'noted' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  addFact(workspaceFor(rig.config, null, 'global'), { text: 'SUBAGENT-FACT the person indents with tabs' });
  const { run } = startFrom(rig, spec('mem', 'check the style'));
  await run();
  const sys = system(model.requests[0]!);
  expect(sys).toContain("The person's task: check the style");
  expect(sys).toContain('SUBAGENT-FACT');
  expect(sys).toContain('Always respond in');
  expect(sys).not.toContain('## Screens');
  // The conversation ends with the task itself: nothing is appended after it.
  expect(rig.sent(0)).toEqual([{ role: 'user', content: 'check the style' }]);
});

test('a model\'s subagent declines a write, journaled `confirm` by background, tagged `subagent`', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'echo x > made.txt' } }], [{ text: 'could not' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { run } = startFrom(rig, spec('w', 'make a file', { by: 'model' }));
  await run();
  expect(fs.existsSync(path.join(rig.root, 'made.txt'))).toBe(false);
  const tagged = rig.journal().filter((e) => e.subagent === 'w' && e.t !== 'subagent');
  expect(tagged.map((e) => e.t)).toEqual(['call-start', 'confirm', 'call']);
  expect(tagged[1]).toMatchObject({ answer: 'no', by: 'background', subagent: 'w' });
  expect(rig.journal().filter((e) => e.task)).toEqual([]);
  expect(rig.conv.confirm).toBeNull();
});

test('its result lands in the session that started it, though another is on screen', async () => {
  const model = new ScriptedModel();
  const task = subScript(model, 'find it');
  task.script([{ hold: true }, { text: 'found it' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  rig.registry.show(first);
  const child = scheduled(rig, spec('find', 'find it'));
  await rig.until(() => task.held);
  await rig.until(() => first.sessionId !== '');
  first.title = 'the first';
  const second = rig.fresh();
  rig.registry.show(second);
  task.release();
  await rig.until(() => bgRows(first).length === 1);
  await settled(rig);
  expect(child.closed).toBe(true);
  expect(bgRows(first)).toEqual(['find finished:\nfound it']);
  expect(bgRows(second)).toEqual([]);
  expect(rig.toasts).toContain('⏳ find done — in «the first»');
});

test('a task a subagent starts reports to the session, not to the subagent that is still running', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'one');
  sub.script([{ tool: 'subagent', args: { task: 'two', label: 'g' } }], [{ hold: true }, { text: 's done' }]);
  model.when((req) => system(req).includes('Task: two')).script([{ text: 'g done' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  rig.registry.show(first);
  const s = scheduled(rig, spec('s', 'one'));
  // The task's result is in the session while the subagent that started it still runs.
  await rig.until(() => sub.held && bgRows(first).length === 1, 5_000);
  expect(bgRows(first)).toEqual(['g finished:\ng done']);
  expect(s.inbox).toEqual([]);
  sub.release();
  await rig.until(() => bgRows(first).length === 2, 5_000);
  await settled(rig);
  expect(bgRows(first)).toEqual(['g finished:\ng done', 's finished:\ns done']);
  expect(first.children.size).toBe(0);
});

test('a long run that compacts sends its summary with the next round', async () => {
  const model = new ScriptedModel();
  // The compaction request is not a stream: it goes to the main script.
  model.script([{ text: handoff(`FOLDED-GOAL ${'f'.repeat(1500)}`) }]);
  const sub = subScript(model, 'work long');
  sub.usage = { prompt_tokens: 19_000, completion_tokens: 10 };
  sub.script([{ tool: 'datetime', args: {} }], [{ text: 'resumed' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false, contextWindow: 20_000 } });
  const { child, run } = startFrom(rig, spec('long', 'work long', { summary: 'HANDED-OVER-SUMMARY' }));
  expect(await run()).toMatchObject({ outcome: 'answer', text: 'resumed' });
  expect(sub.requests).toHaveLength(2);
  // The summary handed over rides the first round...
  expect(system(sub.requests[0]!)).toContain('HANDED-OVER-SUMMARY');
  // ...and the compaction's own replaces it for the next.
  expect(system(sub.requests[1]!)).toContain('FOLDED-GOAL');
  expect(system(sub.requests[1]!)).not.toContain('HANDED-OVER-SUMMARY');
  expect(child.summary).toContain('FOLDED-GOAL');
});

test('a child with the memory record missing spends the host\'s once-only note nowhere; the session still says it', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'child done' }], [{ text: 'session answer' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  fs.rmSync(memoryTrustPath(), { force: true });
  const { run } = startFrom(rig, spec('quiet', 'say nothing of the record'));
  await run();
  expect(rig.deps.said?.memoryMissing).toBe(false);
  expect(rig.conv.messages.filter((m) => m.role === 'note')).toEqual([]);
  await rig.conv.send('hi');
  expect(rig.conv.messages.some((m) => m.role === 'note' && String(m.content).includes('is missing'))).toBe(true);
});

test('its start and its end are in the journal of the session that started it, and /export draws them', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'fine' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { run } = startFrom(rig, spec('j', 'do it'));
  await run();
  const lines = rig.journal().filter((e) => e.t === 'subagent');
  expect(lines).toMatchObject([
    { t: 'subagent', label: 'j', by: 'person', event: 'start', subagent: 'j' },
    { t: 'subagent', label: 'j', by: 'person', event: 'end', outcome: 'answer', subagent: 'j' },
  ]);
  const md = exportMarkdown(rig.journal(), { title: 't', id: rig.conv.sessionId });
  expect(md).toContain('*Subagent «j» started (by you)');
  expect(md).toContain('*Subagent «j» finished*');
});

test('/export draws a subagent\'s calls under its label', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'noon' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { run } = startFrom(rig, spec('clock', 'what time'));
  await run();
  const md = exportMarkdown(rig.journal(), { title: 't', id: rig.conv.sessionId });
  expect(md).toContain('datetime · ok · subagent «clock»');
});

test('an exit close writes the end line of a subagent still running, and no task-end', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'wait');
  sub.script([{ hold: true }, { text: 'never' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { run } = startFrom(rig, spec('x', 'wait'));
  const running = run();
  await rig.until(() => sub.held);
  rig.registry.closeAll('exit');
  sub.release();
  expect(await running).toMatchObject({ stoppedWithParent: true });
  const ends = rig.journal().filter((e) => e.t === 'subagent' && e.event === 'end');
  expect(ends).toMatchObject([{ label: 'x', outcome: 'stopped', stoppedBy: 'exit' }]);
  expect(rig.journal().filter((e) => e.t === 'task-end')).toEqual([]);
});

test('an exit close stops a subagent\'s turn: it asks the model nothing more', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'wait');
  sub.script([{ hold: true }, { text: 'never' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { child, run } = startFrom(rig, spec('x', 'wait'));
  const running = run();
  await rig.until(() => sub.held);
  child.close('exit');
  sub.release();
  await running;
  expect(child.lastEnd?.outcome).toBe('stopped');
  expect(child.content).toBe('');
});

test('a subagent that ends hands the children still live to its parent', async () => {
  const model = new ScriptedModel();
  subScript(model, 'one').script([{ tool: 'subagent', args: { task: 'two', label: 'g', in: '3 minutes' } }], [{ text: 's done' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  rig.registry.show(first);
  const s = scheduled(rig, spec('s', 'one'));
  await rig.until(() => s.closed && first.children.size === 1, 5_000);
  const [g] = [...first.children];
  expect(g!.label).toBe('g');
  expect(g!.parent).toBe(first);
  expect(first.childTimers.has(g!)).toBe(true);
});

test('the result carries how long the child ran and what it cost', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'cost');
  sub.usage = { prompt_tokens: 120, completion_tokens: 30 };
  sub.script([{ text: 'done' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { run } = startFrom(rig, spec('c', 'cost'));
  const r = await run();
  expect(r.tokens).toBe(150);
  expect(typeof r.ms).toBe('number');
});

test('the settings-file guard never runs in a subagent: nothing is parked, nothing checked', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'done' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  let checked = 0;
  (rig.services as unknown as Record<string, unknown>).configChanges = {
    check: () => { checked++; return [{ path: '/x/config.json', file: 'config.json', hash: 'h', lines: ['ai.model'] }]; },
    apply: () => ({ applied: [], restart: [] }), decline: () => null,
  };
  const { child, run } = startFrom(rig, spec('g', 'noon'));
  expect(await run()).toMatchObject({ outcome: 'answer' });
  expect(child.confirm).toBeNull();
  expect(child.configAsk).toBeNull();
  expect(checked).toBe(0);
});

// ── stopping one, and remembering the ended
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A session whose follow-up turn is on and which the chat shows: a stopped child's row must
// still start no turn in it.
const attachedRig = (model: ScriptedModel, ai: Record<string, unknown> = {}, extra?: Record<string, unknown>) =>
  conversationRig(model, { inbox: true, ai: { backgroundFollowUp: true, ...ai }, ...(extra ? { extra } : {}) });

test('a subagent stopped mid-turn delivers `stopped:` and the text it had; no follow-up turn starts, and one toast says so', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'write it');
  sub.script([{ text: 'half an answer' }, { hold: true }, { text: 'never' }]);
  const rig = attachedRig(model);
  const first = rig.conv;
  rig.registry.show(first);
  const child = scheduled(rig, spec('w', 'write it'));
  await rig.until(() => sub.held);
  expect(child.stopSubtree('')).toBe(true);
  await rig.until(() => bgRows(first).length === 1);
  await settled(rig);
  await wait(60);
  expect(bgRows(first)).toEqual(['w stopped:\nhalf an answer']);
  expect(rig.toasts).toEqual(['■ w stopped']);
  expect(rig.log).toContain('[bg] w stopped');
  // Only the subagent's own request went out: the row started no turn in the session.
  expect(model.requests).toHaveLength(1);
  expect(first.busy).toBe(false);
  expect(rig.journal().filter((e) => e.t === 'subagent' && e.event === 'end')).toMatchObject([{ label: 'w', outcome: 'stopped' }]);
});

test('a subagent stopped before it spoke delivers `nothing said yet`', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'think');
  sub.script([{ hold: true }, { text: 'never' }]);
  const rig = attachedRig(model);
  const first = rig.conv;
  const child = scheduled(rig, spec('t', 'think'));
  await rig.until(() => sub.held);
  child.stopSubtree('^c');
  await rig.until(() => bgRows(first).length === 1);
  await settled(rig);
  expect(bgRows(first)).toEqual(['t stopped:\nnothing said yet']);
  expect(child.lastEnd).toMatchObject({ outcome: 'stopped', stoppedBy: '^c' });
});

test('a second stop does nothing: one row, one toast', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'again');
  sub.script([{ hold: true }, { text: 'never' }]);
  const rig = attachedRig(model);
  const first = rig.conv;
  const child = scheduled(rig, spec('a', 'again'));
  await rig.until(() => sub.held);
  expect(child.stopSubtree('')).toBe(true);
  expect(child.stopSubtree('')).toBe(false);
  await rig.until(() => bgRows(first).length === 1);
  await settled(rig);
  expect(child.stopSubtree('')).toBe(false);
  await wait(30);
  expect(bgRows(first)).toHaveLength(1);
  expect(rig.toasts).toEqual(['■ a stopped']);
});

test('stopped while delayed: no request is sent, the arm count and the timer are released, the row is delivered', async () => {
  const model = new ScriptedModel();
  const rig = attachedRig(model);
  const first = rig.conv;
  const child = scheduled(rig, spec('d', 'later'), first, 180_000);
  expect(rig.registry.children.backgroundCount()).toBe(1);
  expect(first.childTimers.size).toBe(1);
  expect(child.stopSubtree('')).toBe(true);
  await rig.until(() => bgRows(first).length === 1);
  await settled(rig);
  expect(rig.registry.children.backgroundCount()).toBe(0);
  expect(first.childTimers.size).toBe(0);
  expect(first.children.size).toBe(0);
  expect(model.requests).toHaveLength(0);
  expect(bgRows(first)).toEqual(['d stopped:\nnothing said yet']);
  expect(rig.toasts).toEqual(['■ d stopped']);
});

test('stopped while queued for a slot: it leaves the queue at once, sends nothing, and the one running goes on', async () => {
  const model = new ScriptedModel();
  const one = subScript(model, 'one');
  one.script([{ hold: true }, { text: 'one done' }]);
  const two = subScript(model, 'two');
  two.script([{ text: 'never sent' }]);
  const rig = attachedRig(model, { backgroundFollowUp: false }, { sessions: { maxRunning: 2 } });
  const first = rig.conv;
  scheduled(rig, spec('a', 'one'));
  const b = scheduled(rig, spec('b', 'two'));
  await rig.until(() => one.held && rig.registry.children.backgroundCount() === 2);
  expect(rig.registry.children.running()).toBe(1);
  expect(b.stopSubtree('')).toBe(true);
  // Its place in the queue is given up now, not when a slot frees.
  expect(rig.registry.children.backgroundCount()).toBe(1);
  await rig.until(() => bgRows(first).length === 1);
  expect(bgRows(first)).toEqual(['b stopped:\nnothing said yet']);
  one.release();
  await rig.until(() => bgRows(first).length === 2);
  await settled(rig);
  expect(two.requests).toHaveLength(0);
  expect(bgRows(first)[1]).toBe('a finished:\none done');
});

test('stopping a subagent closes the tasks it started: they deliver nothing, only it does', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'parent job');
  sub.script([{ tool: 'subagent', args: { task: 'child job', label: 'g' } }], [{ hold: true }, { text: 'never' }]);
  const g = model.when((req) => system(req).includes('Task: child job'));
  g.script([{ hold: true }, { text: 'g done' }]);
  const rig = attachedRig(model);
  const first = rig.conv;
  const s = scheduled(rig, spec('s', 'parent job'));
  await rig.until(() => g.held && sub.held);
  const [grandchild] = [...s.children];
  expect(grandchild!.label).toBe('g');
  expect(s.stopSubtree('')).toBe(true);
  expect(grandchild!.closeReason).toBe('parent');
  expect(s.children.size).toBe(0);
  await rig.until(() => bgRows(first).length === 1);
  await settled(rig);
  g.release();
  await wait(60);
  expect(bgRows(first)).toEqual(['s stopped:\nnothing said yet']);
  expect(rig.toasts).toEqual(['■ s stopped']);
  expect(rig.log).toContain('[bg] g stopped with its conversation');
  expect(g.requests).toHaveLength(1);
});

// ── what the journal says about a stop
const endsOf = (rig: Rig, t: 'subagent' | 'task-end') => rig.journal().filter((e) => e.t === t && (t === 'task-end' || e.event === 'end'));

test('a subagent the person stops says so in its end line, and /export reads "by you"', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'by hand');
  sub.script([{ hold: true }, { text: 'never' }]);
  const rig = attachedRig(model, { backgroundFollowUp: false });
  const child = scheduled(rig, spec('h', 'by hand'));
  await rig.until(() => sub.held);
  child.stopSubtree('');
  await settled(rig);
  expect(endsOf(rig, 'subagent')).toMatchObject([{ label: 'h', outcome: 'stopped', stoppedBy: 'person' }]);
  expect(exportMarkdown(rig.journal(), { title: 't', id: rig.conv.sessionId })).toContain('*Subagent «h» stopped (by you)*');
});

test('a task the person stops writes its task-end line by the person; the one that finishes writes none', async () => {
  const model = new ScriptedModel();
  const t = model.when((req) => system(req).includes('Task: slow job'));
  t.script([{ hold: true }, { text: 'never' }]);
  const rig = attachedRig(model, { backgroundFollowUp: false });
  const task = scheduled(rig, { kind: 'task', label: 'tk', prompt: 'slow job', by: 'model' });
  await rig.until(() => t.held);
  task.stopSubtree('');
  await settled(rig);
  expect(endsOf(rig, 'task-end')).toMatchObject([{ task: 'tk', outcome: 'stopped', by: 'person' }]);
  expect(exportMarkdown(rig.journal(), { title: 't', id: rig.conv.sessionId })).toContain('*tk stopped (by you)*');
});

test('the children closed because their parent was stopped write the person too, not a clear', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'parent job');
  sub.script([{ tool: 'subagent', args: { task: 'child job', label: 'g' } }], [{ hold: true }, { text: 'never' }]);
  const g = model.when((req) => system(req).includes('Task: child job'));
  g.script([{ hold: true }, { text: 'g done' }]);
  const rig = attachedRig(model, { backgroundFollowUp: false });
  const s = scheduled(rig, spec('s', 'parent job'));
  await rig.until(() => g.held && sub.held);
  s.stopSubtree('');
  await settled(rig);
  g.release();
  expect(endsOf(rig, 'task-end')).toMatchObject([{ task: 'g', outcome: 'stopped', by: 'person' }]);
  expect(endsOf(rig, 'subagent')).toMatchObject([{ label: 's', outcome: 'stopped', stoppedBy: 'person' }]);
});

test('a child closed because its parent closes still delivers nothing', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'cleared');
  sub.script([{ hold: true }, { text: 'never' }]);
  const rig = attachedRig(model);
  const first = rig.conv;
  scheduled(rig, spec('c', 'cleared'));
  await rig.until(() => sub.held);
  first.close('clear');
  await settled(rig);
  expect(bgRows(first)).toEqual([]);
  expect(rig.toasts).toEqual([]);
  expect(first.endedChildren).toEqual([]);
  // A subagent cleared with its session still writes its end line, by the clear.
  expect(endsOf(rig, 'subagent')).toMatchObject([{ label: 'c', outcome: 'stopped', stoppedBy: 'clear' }]);
});

test('the ended children are remembered as plain data, newest last, twenty at most, until /clear', async () => {
  const model = new ScriptedModel();
  const sub = model.when((req) => system(req).includes("The person's task:") && (req as { stream?: boolean }).stream === true);
  sub.usage = { prompt_tokens: 40, completion_tokens: 2 };
  sub.script(...Array.from({ length: 22 }, (_, i) => [{ text: `r${i}` }]));
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  for (let i = 0; i < 22; i++) await startFrom(rig, spec(`c${i}`, `job ${i}`)).run();
  const ended = first.endedChildren;
  expect(ended).toHaveLength(20);
  expect(ended.map((e) => e.label)).toEqual(Array.from({ length: 20 }, (_, i) => `c${i + 2}`));
  expect(Object.keys(ended[0]!).sort()).toEqual(['kind', 'label', 'ms', 'outcome', 'tokens']);
  expect(ended[0]).toMatchObject({ kind: 'subagent', outcome: 'answer', tokens: 42 });
  expect(typeof ended[0]!.ms).toBe('number');
  expect(() => JSON.stringify(ended)).not.toThrow();
  first.close('clear');
  expect(first.endedChildren).toEqual([]);
});

test('a stopped child is remembered with its outcome; one handed up is remembered where it settles', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'one');
  sub.script([{ tool: 'subagent', args: { task: 'two', label: 'g', in: '3 minutes' } }], [{ text: 's done' }]);
  const rig = attachedRig(model, { backgroundFollowUp: false });
  const first = rig.conv;
  const s = scheduled(rig, spec('s', 'one'));
  await rig.until(() => s.closed && first.children.size === 1, 5_000);
  const [g] = [...first.children];
  expect(g!.parent).toBe(first);
  g!.stopSubtree('');
  await rig.until(() => first.endedChildren.length === 2, 5_000);
  expect(first.endedChildren.map((e) => [e.label, e.kind, e.outcome])).toEqual([['s', 'subagent', 'answer'], ['g', 'task', 'stopped']]);
  expect(s.endedChildren).toEqual([]);
});

test('the running children are listed with their status: working, queued for a slot, delayed', async () => {
  const model = new ScriptedModel();
  const one = subScript(model, 'one');
  one.script([{ hold: true }, { text: 'x' }]);
  const rig = attachedRig(model, { backgroundFollowUp: false }, { sessions: { maxRunning: 2 } });
  const first = rig.conv;
  scheduled(rig, spec('a', 'one'));
  scheduled(rig, spec('b', 'two'));
  const before = Date.now();
  scheduled(rig, spec('c', 'three'), first, 120_000);
  await rig.until(() => one.held);
  const list = first.runningChildren();
  expect(list.map((c) => [c.label, c.kind, c.status])).toEqual([['a', 'subagent', 'working'], ['b', 'subagent', 'queued'], ['c', 'subagent', 'delayed']]);
  expect(list[0]!.startedAt).toBeGreaterThanOrEqual(before - 1_000);
  expect(list[1]!.startedAt).toBeNull();
  expect(list[2]!.until).toBeGreaterThanOrEqual(before + 119_000);
  expect(list[0]!.until).toBeNull();
});
