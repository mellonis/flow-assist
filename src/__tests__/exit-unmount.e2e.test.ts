// The chat's unmount only writes and unlocks what is live: it stops no task, and a
// session left while its task runs still gets the result — a test process unmounts chats
// whose work goes on. Stopping everything is the exit hook's
// (AGENTS.md (a host makes its conversations through one registry)).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJournal, type JournalEvent } from '../assistant/journal.ts';
import { ScriptedModel, bootApp, settle, type RecordedRequest } from './helpers/scripted';
import { listTree, sessionIdOf } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const system = (req: RecordedRequest): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
type Saved = { id: string; messages: { role: string; content: unknown }[] };
const saved = (dir: string, text: string): Saved | undefined => listTree(dir).filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Saved)
  .find((s) => s.messages.some((m) => m.content === text));
const journalOf = (dir: string, id: string): JournalEvent[] => {
  const name = listTree(dir).find((n) => sessionIdOf(n) === id && n.endsWith('.log.jsonl'));
  return name ? readJournal(path.join(dir, name)) ?? [] : [];
};

test('unmounting the chat stops no task: the session left gets its result, and no task-end line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-exit-unmount-e2e-'));
  const model = new ScriptedModel();
  model.script([{ tool: 'subagent', args: { task: 'slow job', label: 'job' } }], [{ text: 'Started it.' }]);
  const task = model.when((req) => system(req).includes('Task: slow job'));
  task.script([{ hold: true }, { text: 'job result' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } }, { toastMs: 10_000 });
  await ui.press('F');
  await ui.type('session A question');
  await ui.press('return');
  await settleUntil(() => task.held && (ui.backend.lastFrame ?? '').includes('Started it.'));
  await settleUntil(() => saved(dir, 'session A question') !== undefined);
  const idA = saved(dir, 'session A question')!.id;
  await ui.type('/new');
  await ui.press('return');
  await settle(4);

  ui.app.unmount();
  task.release();
  const landed = () => journalOf(dir, idA).some((e) => e.t === 'row' && (e as { role?: string }).role === 'bg');
  await settleUntil(landed);
  expect(landed()).toBe(true);
  expect(journalOf(dir, idA).filter((e) => e.t === 'task-end')).toEqual([]);
});
