// A session left by /resume, the picker or /new while its turn runs goes on headless: its
// rows reach its journal, the picker reads it `here · working`, and it is put away `done`
// once the turn ends (AGENTS.md (a host makes its conversations through one registry)).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJournal, type JournalEvent } from '../assistant/journal.ts';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';
import { homeIn, listTree, sessionIdOf } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-leave-busy-'));
type Saved = { id: string; messages: { role: string; content: unknown }[]; draft: string; answeredAt?: string; seenAt?: string };
const saved = (dir: string, text: string): Saved | undefined => listTree(dir).filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Saved)
  .find((s) => s.messages.some((m) => m.content === text));
const journalOf = (dir: string, id: string): JournalEvent[] => {
  const name = listTree(dir).find((n) => sessionIdOf(n) === id && n.endsWith('.log.jsonl'));
  return name ? readJournal(path.join(dir, name)) ?? [] : [];
};
const lockOf = (dir: string, id: string) => path.join(homeIn(dir, id), `${id}.lock`);
const rowOf = (frame: string, text: string) => frame.split('\n').find((r) => r.includes(text)) ?? '';
const frameOf = (ui: { backend: { lastFrame?: string } }) => ui.backend.lastFrame ?? '';

type UI = Awaited<ReturnType<typeof bootApp>>;
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
// Opens the picker, walks the cursor to the row holding `text`, and takes it with ⏎.
async function pick(ui: UI, text: string) {
  ui.backend.press({ name: 's', ctrl: true });
  await settle(3);
  const rows = frameOf(ui).split('\n').filter((r) => / msgs? │/.test(r));
  const at = rows.findIndex((r) => r.includes(text));
  if (at < 0) throw new Error(`pick: no row with ${text}`);
  for (let i = 0; i < at; i++) { await ui.press('down'); await settle(1); }
  await ui.press('return');
  await settle(4);
}
async function pickerFrame(ui: UI): Promise<string> {
  ui.backend.press({ name: 's', ctrl: true });
  await settle(3);
  const f = frameOf(ui);
  await ui.press('escape');
  await settle(2);
  return f;
}

for (const how of ['/resume', '/new'] as const) {
  test(`#83 via ${how}: a held turn in A goes on headless — its journal, B on screen, here · working — and A is parked done; attaching clears it`, async () => {
    const dir = dirOf();
    const model = new ScriptedModel();
    const aSub = model.when((req) => firstUser(req).includes('session A question'));
    aSub.script([{ hold: true }, { tool: 'datetime', args: {} }], [{ hold: true }, { text: 'A final answer.' }]);
    model.script([{ text: 'B answer.' }]);
    const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } }, { toastMs: 10_000 });
    await ui.press('F');
    if (how === '/resume') {
      // B exists first; A is started after it, and the switch goes back to B.
      await ask(ui, 'session B question');
      await settleUntil(() => frameOf(ui).includes('B answer.') && !!saved(dir, 'session B question'));
      await ask(ui, '/new');
      await settle(4);
    }
    await ask(ui, 'session A question');
    await settleUntil(() => aSub.held && !!saved(dir, 'session A question'));
    const idA = saved(dir, 'session A question')!.id;

    if (how === '/resume') await pick(ui, 'session B question');
    else {
      await ask(ui, '/new');
      await settle(4);
      await ask(ui, 'session B question');
      await settleUntil(() => frameOf(ui).includes('B answer.'));
    }
    let frame = frameOf(ui);
    expect(frame).toContain('B answer.');
    expect(frame).not.toContain('session A question');
    expect(frame).not.toContain('an answer is still coming');
    expect(fs.existsSync(lockOf(dir, idA))).toBe(true);
    expect(rowOf(await pickerFrame(ui), 'session A question')).toContain('here · working');

    // A's first round goes on: its tool call reaches A's journal — the state file is
    // written at a turn's start and end only, attached or not — and not the screen.
    aSub.release();
    await settleUntil(() => aSub.held && journalOf(dir, idA).some((e) => e.t === 'call'));
    expect(journalOf(dir, idA).some((e) => e.t === 'call' && JSON.stringify(e).includes('datetime'))).toBe(true);
    expect(frameOf(ui)).toContain('B answer.');
    expect(fs.existsSync(lockOf(dir, idA))).toBe(true);

    aSub.release();
    await settleUntil(() => !fs.existsSync(lockOf(dir, idA)));
    expect(fs.existsSync(lockOf(dir, idA))).toBe(false);
    expect(saved(dir, 'session A question')!.messages.map((m) => m.content)).toContain('A final answer.');
    expect(frameOf(ui)).not.toContain('A final answer.');
    // Parked: the picker reads its file — `done`, a plain row, not `here`.
    frame = await pickerFrame(ui);
    expect(rowOf(frame, 'session A question')).toContain('done');
    expect(rowOf(frame, 'session A question')).not.toContain('here');

    // Attached: the answer on screen; and once left again, no longer `done`.
    await pick(ui, 'session A question');
    expect(frameOf(ui)).toContain('A final answer.');
    await pick(ui, 'session B question');
    await settle(4);
    expect(rowOf(await pickerFrame(ui), 'session A question')).not.toContain('done');
    ui.app.unmount();
  });
}


test('/resume of the session on screen while its turn runs changes nothing', async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  const aSub = model.when((req) => firstUser(req).includes('session A question'));
  aSub.script([{ hold: true }, { tool: 'datetime', args: {} }], [{ hold: true }, { text: 'A final answer.' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } }, { toastMs: 10_000 });
  await ui.press('F');
  await ask(ui, 'session A question');
  await settleUntil(() => aSub.held && !!saved(dir, 'session A question'));
  const idA = saved(dir, 'session A question')!.id;
  const lockBefore = fs.readFileSync(lockOf(dir, idA), 'utf8');
  await pick(ui, 'session A question');
  expect(fs.readFileSync(lockOf(dir, idA), 'utf8')).toBe(lockBefore);
  expect(frameOf(ui)).not.toContain('an answer is still coming');
  aSub.release();
  await settleUntil(() => aSub.held && journalOf(dir, idA).some((e) => e.t === 'call'));
  aSub.release();
  await settleUntil(() => frameOf(ui).includes('A final answer.'));
  expect(frameOf(ui)).toContain('A final answer.');
  expect(fs.existsSync(lockOf(dir, idA))).toBe(true);
  expect(fs.readFileSync(lockOf(dir, idA), 'utf8')).toBe(lockBefore);
  ui.app.unmount();
});
