// A subagent's journal: its own file in the root session's `<id>.sub` directory, flat
// whatever the depth, holding everything the conversation holds; the session's journal
// keeps only the `subagent` start and end lines, each with the file's id. A task writes
// its tagged lines into the file of the nearest subagent above it, else the session's.
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

// A subagent of the rig's session, started as a slash command does: from the journal id
// of a row of the person's, which gives the session its id and its home.
function startFrom(rig: Rig, s: ChildSpec, from: Conversation = rig.conv) {
  const id = from.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const started = from.startChild(s, id);
  if ('refused' in started) throw new Error(`refused: ${started.refused}`);
  children.push(started.child);
  return { ...started, id };
}
const scheduled = (rig: Rig, s: ChildSpec) => {
  const id = rig.conv.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const r = scheduleChild(s, 0, {
    startChild: (sp) => rig.conv.startChild(sp, id), slots: rig.registry.children,
    showMessage: rig.services.showMessage, pushLog: rig.services.pushLog, notify: () => {},
  });
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  children.push(r.child);
  return r.child;
};
const settled = (rig: Rig) => rig.until(() => rig.registry.children.backgroundCount() === 0, 5_000);
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const kinds = (events: { t: string }[]) => events.map((e) => e.t);

test('a subagent leaves a file under the session\'s .sub: start first, end last, 0600 in a 0700 directory, with its rows, steps and answer', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'looking', tool: 'datetime', args: {} }], [{ text: 'noon' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { run, child } = startFrom(rig, spec('clock', 'what time'));
  await run();
  const [j] = rig.subJournals();
  expect(rig.subJournals()).toHaveLength(1);
  expect(j!.id).toBe(child.subJournalId!);
  expect(j!.events[0]).toMatchObject({ t: 'start', id: j!.id, parent: rig.conv.sessionId, root: rig.conv.sessionId, label: 'clock', by: 'person' });
  expect(j!.events.at(-1)!.t).toBe('end');
  expect(j!.events.find((e) => e.t === 'row')).toMatchObject({ role: 'user', text: 'what time' });
  expect(j!.events.find((e) => e.t === 'step')).toMatchObject({ text: 'looking' });
  expect(j!.events.find((e) => e.t === 'answer')).toMatchObject({ text: 'noon' });
  expect(kinds(j!.events)).toContain('call-start');
  expect(kinds(j!.events)).toContain('call');
  expect(mode(j!.file)).toBe(0o600);
  expect(mode(path.dirname(j!.file))).toBe(0o700);
});

test('the session\'s journal keeps exactly the subagent\'s start and end lines, each with the file\'s id, and none of its calls', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'noon' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { run } = startFrom(rig, spec('clock', 'what time'));
  await run();
  const id = rig.subJournals()[0]!.id;
  const own = rig.journal().filter((e) => e.t !== 'row' && e.t !== 'start');
  expect(own).toMatchObject([
    { t: 'subagent', event: 'start', label: 'clock', id },
    { t: 'subagent', event: 'end', label: 'clock', outcome: 'answer', id },
  ]);
  expect(own).toHaveLength(2);
});

test('two subagents with one label have two files', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  await startFrom(rig, spec('same', 'first')).run();
  await startFrom(rig, spec('same', 'second')).run();
  const files = rig.subJournals();
  expect(files).toHaveLength(2);
  expect(new Set(files.map((f) => f.id)).size).toBe(2);
  const ids = rig.journal().filter((e) => e.t === 'subagent' && e.event === 'start').map((e) => e.id);
  expect(new Set(ids)).toEqual(new Set(files.map((f) => f.id)));
});

test('a subagent of a subagent lies flat in the root\'s .sub, its parent field naming the middle one', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'inner done' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { child: middle } = startFrom(rig, spec('middle', 'unused'));
  const nested = middle.startChild(spec('inner', 'deep'), '');
  if ('refused' in nested) throw new Error(nested.refused);
  children.push(nested.child);
  await nested.run();
  const files = rig.subJournals();
  expect(files).toHaveLength(2);
  expect(files.every((f) => path.dirname(f.file) === path.dirname(files[0]!.file))).toBe(true);
  const inner = files.find((f) => f.events[0]!.label === 'inner')!;
  expect(inner.events[0]).toMatchObject({ t: 'start', parent: middle.subJournalId, root: rig.conv.sessionId });
  // The inner one's start and end lines are in the middle one's file, not the session's.
  expect(rig.subJournal('middle').filter((e) => e.t === 'subagent')).toMatchObject([{ event: 'start', label: 'inner', id: inner.id }, { event: 'end', label: 'inner', id: inner.id }]);
  expect(rig.journal().filter((e) => e.t === 'subagent' && e.label === 'inner')).toEqual([]);
});

test('a task a subagent starts writes its tagged lines into that subagent\'s file, and the session\'s journal hears nothing of it', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'parent job');
  sub.script([{ tool: 'subagent', args: { task: 'child job', label: 'g' } }], [{ text: 'started' }]);
  model.when((req) => system(req).includes('Task: child job')).script([{ tool: 'datetime', args: {} }], [{ text: 'g done' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { run } = startFrom(rig, spec('s', 'parent job'));
  await run();
  await settled(rig);
  const own = rig.subJournal('s');
  expect(own.filter((e) => e.task === 'g').map((e) => e.t)).toEqual(['call-start', 'call']);
  expect(rig.journal().filter((e) => e.task)).toEqual([]);
  expect(rig.subJournals()).toHaveLength(1);
});

test('stopped by the person, the subagent\'s file ends `stopped` by the person, and the session\'s end line says so', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'by hand');
  sub.script([{ hold: true }, { text: 'never' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const child = scheduled(rig, spec('h', 'by hand'));
  await rig.until(() => sub.held);
  child.stopSubtree('');
  await settled(rig);
  const ends = rig.subJournal('h').filter((e) => e.t === 'end');
  expect(ends).toMatchObject([{ stopped: 'person' }]);
  expect(rig.subJournal('h').at(-1)).toMatchObject({ t: 'end', stopped: 'person' });
  expect(rig.journal().find((e) => e.event === 'end')).toMatchObject({ stoppedBy: 'person', id: child.subJournalId });
});

test('stopped by /clear, the file ends `stopped` clear, and the aborted turn adds no end after it', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'cleared');
  sub.script([{ hold: true }, { text: 'never' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  startFrom(rig, spec('c', 'cleared')).run().catch(() => {});
  await rig.until(() => sub.held);
  first.close('clear');
  sub.release();
  await new Promise((r) => setTimeout(r, 40));
  const own = rig.subJournal('c', first.sessionId);
  expect(own.at(-1)).toMatchObject({ t: 'end', stopped: 'clear' });
  expect(own.filter((e) => e.t === 'end')).toHaveLength(1);
  expect(rig.journal(first.sessionId).find((e) => e.event === 'end')).toMatchObject({ stoppedBy: 'clear' });
});

test('at exit the file ends `stopped` exit, and so does the session\'s line', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'wait');
  sub.script([{ hold: true }, { text: 'never' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { run } = startFrom(rig, spec('x', 'wait'));
  const running = run();
  await rig.until(() => sub.held);
  rig.registry.closeAll('exit');
  sub.release();
  await running;
  const own = rig.subJournal('x');
  expect(own.at(-1)).toMatchObject({ t: 'end', stopped: 'exit' });
  expect(own.filter((e) => e.t === 'end')).toHaveLength(1);
  expect(rig.journal().find((e) => e.event === 'end')).toMatchObject({ stoppedBy: 'exit' });
});

test('a session with nowhere to keep a journal gives its subagent no file, whether sessions are off or nothing was said yet', async () => {
  const off = new ScriptedModel();
  off.script([{ text: 'done' }]);
  const rigOff = conversationRig(off, { sessions: false, ai: { backgroundFollowUp: false } });
  const a = rigOff.conv.startChild(spec('a', 'go'), '');
  if ('refused' in a) throw new Error(a.refused);
  children.push(a.child);
  expect(a.child.subJournalId).toBeNull();
  await a.run();
  expect(rigOff.journals()).toEqual([]);

  const unsaid = new ScriptedModel();
  unsaid.script([{ text: 'done' }]);
  const rig = conversationRig(unsaid, { ai: { backgroundFollowUp: false } });
  const b = rig.conv.startChild(spec('b', 'go'), '');
  if ('refused' in b) throw new Error(b.refused);
  children.push(b.child);
  expect(b.child.subJournalId).toBeNull();
  await b.run();
  expect(rig.journals()).toEqual([]);
});

test('a session moved to another directory mid-run: the next line lands in the new place, in the same file', async () => {
  const model = new ScriptedModel();
  const sub = subScript(model, 'moving');
  sub.script([{ tool: 'datetime', args: {} }, { hold: true }], [{ text: 'arrived' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const { run } = startFrom(rig, spec('m', 'moving'));
  const running = run();
  await rig.until(() => sub.held);
  const id = rig.conv.sessionId;
  const home = rig.conv.homes.get(id)!;
  const from = rig.subJournals()[0]!.file;
  // What the picker's move does to the files, and to where the session's id is kept.
  const dest = path.join(rig.sessionsDir!, 'moved-to');
  fs.mkdirSync(dest, { recursive: true });
  fs.renameSync(path.join(home, `${id}.log.jsonl`), path.join(dest, `${id}.log.jsonl`));
  fs.renameSync(path.join(home, `${id}.sub`), path.join(dest, `${id}.sub`));
  rig.conv.homes.set(id, dest);
  sub.release();
  await running;
  expect(fs.existsSync(from)).toBe(false);
  const moved = path.join(dest, `${id}.sub`, path.basename(from));
  const events = rig.subJournal('m');
  expect(fs.existsSync(moved)).toBe(true);
  expect(events[0]).toMatchObject({ t: 'start' });
  expect(events.at(-1)!.t).toBe('end');
  expect(kinds(events)).toContain('answer');
});
