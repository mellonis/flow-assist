// A session the chat leaves while its background task runs stays loaded here, locked and
// drawn by nobody, until the task ends: the result lands in that session's file and
// journal, not on screen, and starts no turn; the session is put away afterwards. Taken
// back while the task runs, it is the same conversation, with its draft
// (AGENTS.md (a host makes its conversations through one registry)).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJournal, type JournalEvent } from '../assistant/journal.ts';
import { ScriptedModel, bootApp, settle, type RecordedRequest } from './helpers/scripted';
import { homeIn, listTree, sessionIdOf } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
// Past the inbox's own 400 ms tick: a turn it would start has started by then.
const pastTick = () => new Promise((r) => setTimeout(r, 500)).then(() => settle(10));
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-headless-e2e-'));
const system = (req: RecordedRequest): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
type Saved = { id: string; messages: { role: string; content: unknown }[]; draft: string };
// The saved session whose conversation holds `text`.
const saved = (dir: string, text: string): Saved | undefined => listTree(dir).filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Saved)
  .find((s) => s.messages.some((m) => m.content === text));
const bgRows = (s: Saved | undefined) => (s?.messages ?? []).filter((m) => m.role === 'bg').map((m) => String(m.content));
const journalOf = (dir: string, id: string): JournalEvent[] => {
  const name = listTree(dir).find((n) => sessionIdOf(n) === id && n.endsWith('.log.jsonl'));
  return name ? readJournal(path.join(dir, name)) ?? [] : [];
};
const bgLines = (dir: string, id: string) => journalOf(dir, id).filter((e) => e.t === 'row' && (e as { role?: string }).role === 'bg');
const lockOf = (dir: string, id: string) => path.join(homeIn(dir, id), `${id}.lock`);
// What tells one lock file from its rewrite: the file itself and what it says.
const lockMark = (file: string) => { const st = fs.statSync(file); return `${st.ino}:${fs.readFileSync(file, 'utf8')}`; };
const fieldRow = (frame: string) => frame.split('\n').filter((r) => r.includes('› ')).at(-1) ?? '';
const RESULT = 'job finished:\njob result';
// The chat's own requests, the task's left out.
const chatRequests = (model: ScriptedModel) => model.requests.filter((r) => !system(r).includes('Task: slow job')).length;

// Session A asks; its answer starts a background task, held until the test releases it.
async function startWithTask(model: ScriptedModel) {
  const dir = dirOf();
  model.script([{ tool: 'background', args: { task: 'slow job', label: 'job' } }], [{ text: 'Started it.' }]);
  const task = model.when((req) => system(req).includes('Task: slow job'));
  task.script([{ hold: true }, { text: 'job result' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } }, { toastMs: 10_000 });
  await ui.press('F');
  await ui.type('session A question');
  await ui.press('return');
  await settleUntil(() => task.held && (ui.backend.lastFrame ?? '').includes('Started it.'));
  await settleUntil(() => saved(dir, 'session A question') !== undefined); // the answer's save, 250 ms on
  const a = saved(dir, 'session A question');
  if (!a) throw new Error('session A was not saved');
  return { dir, ui, task, idA: a.id };
}

test('/new while a task runs: the result lands in the session left, not on screen, with a toast naming it and no turn; that session is put away after', async () => {
  const model = new ScriptedModel();
  const { dir, ui, task, idA } = await startWithTask(model);
  model.script([{ text: 'B answer' }]);
  await ui.type('/new');
  await ui.press('return');
  await settle(4);
  await ui.type('session B question');
  await ui.press('return');
  await settleUntil(() => saved(dir, 'session B question') !== undefined);
  const idB = saved(dir, 'session B question')!.id;
  // Still loaded and locked while its task runs.
  expect(fs.existsSync(lockOf(dir, idA))).toBe(true);
  const sent = chatRequests(model);

  task.release();
  let toast = false;
  await settleUntil(() => {
    if ((ui.backend.lastFrame ?? '').includes('⏳ job done — in «session A question»')) toast = true;
    return toast && bgRows(saved(dir, 'session A question')).length > 0;
  });
  await pastTick();

  // In A's file — though the list the chat last drew of A lacks it — and A's journal.
  expect(bgRows(saved(dir, 'session A question'))).toEqual([RESULT]);
  expect(bgLines(dir, idA).map((e) => (e as { text?: string }).text)).toEqual([RESULT]);
  // Not in B's, and not drawn: only the toast, naming A.
  expect(bgRows(saved(dir, 'session B question'))).toEqual([]);
  expect(bgLines(dir, idB)).toEqual([]);
  expect(toast).toBe(true);
  expect(ui.backend.lastFrame).not.toContain('job result');
  expect(ui.backend.notifications).toEqual([]); // nor an alert, as for this chat's own
  // No follow-up turn for a session nobody draws: nothing went out for it.
  expect(chatRequests(model)).toBe(sent);
  // Put away once its task ended: saved, and its lock released.
  expect(fs.existsSync(lockOf(dir, idA))).toBe(false);
  expect(fs.existsSync(lockOf(dir, idB))).toBe(true);
  ui.app.unmount();
});

test('taken back while its task runs, the session is the same conversation, with its draft; the result then lands on screen with its follow-up, and the session stays', async () => {
  const model = new ScriptedModel();
  const { dir, ui, task, idA } = await startWithTask(model);
  await ui.type('half a thought');
  // Left through the picker's new session, so the field still holds the draft.
  ui.backend.press({ name: 's', ctrl: true });
  await settle();
  ui.backend.press({ name: 'n', ctrl: true });
  await settle(4);
  expect(ui.backend.lastFrame).not.toContain('Started it.');
  await ui.type('/resume 1');
  await ui.press('return');
  await settle(4);
  let frame = ui.backend.lastFrame!;
  expect(frame).toContain('Started it.');
  expect(fieldRow(frame)).toContain('half a thought');

  model.script([{ text: 'Follow-up on the job.' }]);
  task.release();
  await settleUntil(() => (ui.backend.lastFrame ?? '').includes('Follow-up on the job.'));
  frame = ui.backend.lastFrame!;
  expect(frame).toContain('Follow-up on the job.');
  expect(frame).toContain('job result');
  await pastTick();
  // On screen again, it is not put away when its task ends.
  expect(fs.existsSync(lockOf(dir, idA))).toBe(true);
  ui.app.unmount();
});

test('/resume of the session on screen while its task runs keeps that conversation and its lock: the result lands on screen', async () => {
  const model = new ScriptedModel();
  const { dir, ui, task, idA } = await startWithTask(model);
  const before = lockMark(lockOf(dir, idA));
  await ui.type('/resume 1');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('Resumed «session A question»');
  expect(lockMark(lockOf(dir, idA))).toBe(before);

  model.script([{ text: 'Follow-up on the job.' }]);
  task.release();
  await settleUntil(() => (ui.backend.lastFrame ?? '').includes('Follow-up on the job.'));
  expect(ui.backend.lastFrame).toContain('job result');
  // In its file too, by the answer's save.
  await settleUntil(() => saved(dir, RESULT)?.id === idA);
  expect(saved(dir, RESULT)?.id).toBe(idA);
  expect(lockMark(lockOf(dir, idA))).toBe(before);
  ui.app.unmount();
});

test('/resume of the session on screen with nothing running keeps its lock as it is', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'A answer' }]);
  const dir = dirOf();
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await ui.press('F');
  await ui.type('session A question');
  await ui.press('return');
  await settleUntil(() => saved(dir, 'session A question') !== undefined);
  const idA = saved(dir, 'session A question')!.id;
  const before = lockMark(lockOf(dir, idA));
  await ui.type('/resume 1');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('Resumed «session A question»');
  expect(ui.backend.lastFrame).toContain('A answer');
  expect(lockMark(lockOf(dir, idA))).toBe(before);
  ui.app.unmount();
});
