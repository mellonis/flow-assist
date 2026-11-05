// A subagent the person started stays after its answer, and the end of a background shell
// its model started wakes it as a session is woken: only a model-started job, idle, no
// question drawn, under its session being the one on screen, at most MAX_WAKES in a row,
// `ai.backgroundFollowUp` on. A task, and a subagent the model started, are not woken.
import { afterEach, expect, test } from 'bun:test';
import { scheduleChild } from '../assistant/child-schedule.ts';
import type { Conversation } from '../assistant/conversation.ts';
import { MAX_WAKES } from '../assistant/conversation.ts';
import type { ChildSpec } from '../assistant/conversation-types.ts';
import type { ShellJob } from '../assistant/shell-job.ts';
import { ScriptedModel, type RecordedRequest } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';

const strays: ShellJob[] = [];
const children: Conversation[] = [];
afterEach(() => {
  for (const j of strays.splice(0)) { try { j.killNow('exit'); } catch { /* ended */ } }
  for (const c of children.splice(0)) c.close('exit');
  closeRigs();
});

const system = (req: RecordedRequest): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
const subScript = (model: ScriptedModel, task: string) => model.when((req) => system(req).includes(`The person's task: ${task}`) && (req as { stream?: boolean }).stream === true);
const spec = (label: string, prompt: string, over: Partial<ChildSpec> = {}): ChildSpec => ({ kind: 'subagent', label, prompt, by: 'person', ...over });
const settle = () => new Promise((r) => setTimeout(r, 120));

function scheduled(rig: Rig, s: ChildSpec): Conversation {
  const id = rig.conv.journal({ t: 'row', role: 'user', text: 'q' }, { person: true });
  const r = scheduleChild(s, 0, {
    startChild: (sp) => rig.conv.startChild(sp, id), slots: rig.registry.children,
    showMessage: rig.services.showMessage, pushLog: rig.services.pushLog, notify: () => {},
  });
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  children.push(r.child);
  return r.child;
}
function job(c: Conversation, command: string, by: 'model' | 'person' = 'model'): ShellJob {
  const r = c.startJob({ command, cwd: c.shell.cwd(), by });
  if (!('job' in r)) throw new Error(r.refused);
  strays.push(r.job);
  return r.job;
}
const wakes = (c: Conversation) => { const seen: { job: string; woke: boolean }[] = []; c.on('shell-wake', (e) => seen.push({ job: e.job, woke: e.woke })); return seen; };
const bgRows = (c: Conversation): string[] => c.rows().filter((m) => m.role === 'bg').map((m) => String(m.content));
const answered = (rig: Rig, child: Conversation) => rig.until(() => child.idle, 5_000);

// A staying subagent that has given its first answer and rests.
async function resting(ai: Record<string, unknown> = {}, scripts: { text: string }[][] = [[{ text: 'Seen.' }]]) {
  const model = new ScriptedModel();
  const sub = subScript(model, 'stay');
  sub.script([{ text: 'first' }], ...scripts);
  // The session's own turn on the subagent's first answer.
  model.script([{ text: 'noted' }]);
  const rig = conversationRig(model, { inbox: true, ai });
  const child = scheduled(rig, spec('stayer', 'stay'));
  await answered(rig, child);
  await rig.idle();
  return { model: sub, rig, child };
}
const requestsOf = (sub: { requests: unknown[] }) => sub.requests.length;

test('a staying subagent idle after its answer is woken by the end of a job its model started', async () => {
  const { model, rig, child } = await resting();
  const seen = wakes(child);
  const before = requestsOf(model);
  job(child, 'echo built; sleep 0.2');
  await rig.until(() => requestsOf(model) === before + 1, 5_000);
  const last = model.requests.at(-1)!.messages.at(-1)!;
  expect(String(last.content)).toContain('<shell-end n=');
  expect(String(last.content)).toContain('sh-1 · echo built; sleep 0.2 — exited 0');
  expect(seen).toEqual([{ job: 'sh-1', woke: true }]);
  await answered(rig, child);
  expect(child.rows().some((m) => m.role === 'note' && String(m.content) === 'sh-1 ended — waking the model')).toBe(true);
});

test('a job the person started does not wake it: the end lands as a row', async () => {
  const { model, rig, child } = await resting();
  const before = requestsOf(model);
  const j = job(child, 'echo mine', 'person');
  await j.wait(3000);
  await rig.until(() => bgRows(child).length === 1);
  await settle();
  expect(requestsOf(model)).toBe(before);
});

test('ai.backgroundFollowUp: false keeps it asleep with the end in its rows', async () => {
  const { model, rig, child } = await resting({ backgroundFollowUp: false });
  const before = requestsOf(model);
  const j = job(child, 'echo quiet');
  await j.wait(3000);
  await rig.until(() => bgRows(child).length === 1);
  await settle();
  expect(requestsOf(model)).toBe(before);
});

test('a drawn question keeps it asleep; the end is read when the question is answered', async () => {
  const { model, rig, child } = await resting();
  const before = requestsOf(model);
  void child.askUser([{ question: 'which?', header: 'h', options: [] }]);
  expect(child.question).not.toBeNull();
  const j = job(child, 'echo meanwhile');
  await j.wait(3000);
  await settle();
  expect(requestsOf(model)).toBe(before);
  expect(child.inbox.some((i) => i.from.what === 'shell')).toBe(true);
  void rig;
});

test(`after ${MAX_WAKES} woken turns in a row the next end only lands`, async () => {
  const scripts = Array.from({ length: MAX_WAKES }, () => [{ text: 'Seen.' }]);
  const { model, rig, child } = await resting({}, scripts);
  const seen = wakes(child);
  for (let i = 1; i <= MAX_WAKES; i++) {
    const before = requestsOf(model);
    job(child, `echo n${i}`);
    await rig.until(() => requestsOf(model) === before + 1, 5_000);
    await answered(rig, child);
  }
  const before = requestsOf(model);
  const j = job(child, 'echo over');
  await j.wait(3000);
  await settle();
  expect(requestsOf(model)).toBe(before);
  expect(seen.map((s) => s.woke)).toEqual([true, true, true, false]);
  expect(child.inbox.some((i) => i.from.what === 'shell') || bgRows(child).some((r) => r.includes('echo over'))).toBe(true);
});

test('a subagent under a session the chat has left sleeps with it', async () => {
  const { model, rig, child } = await resting();
  const before = requestsOf(model);
  const j = job(child, 'sleep 0.3; echo late');
  expect(rig.switchTo().outcome).toBe('kept');
  await j.wait(5000);
  await settle();
  expect(requestsOf(model)).toBe(before);
});

test('a subagent under a session that is not the one on screen sleeps, though the chat has not left it', async () => {
  const { model, rig, child } = await resting();
  const before = requestsOf(model);
  const other = rig.registry.fresh({ kind: 'session', policy: { kind: 'ask' } });
  rig.registry.show(other);
  const j = job(child, 'echo away');
  await j.wait(3000);
  await settle();
  expect(requestsOf(model)).toBe(before);
  other.close('exit');
});

test('the end of a job of a subagent the model started is not a wake item, and a task\'s neither', async () => {
  const model = new ScriptedModel();
  const hold = subScript(model, 'by model');
  hold.script([{ hold: true }, { text: 'done' }]);
  const rig = conversationRig(model, { inbox: true });
  const sub = scheduled(rig, spec('ms', 'by model', { by: 'model' }));
  await rig.until(() => hold.held, 5_000);
  const j = job(sub, 'echo x');
  await j.wait(3000);
  await settle();
  expect(sub.staying).toBe(false);
  expect(sub.inbox.filter((i) => i.from.what === 'shell').map((i) => i.wake === true)).toEqual([false]);
  hold.release();
});
