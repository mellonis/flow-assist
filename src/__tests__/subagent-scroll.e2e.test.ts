// A landed background result is the boundary of a turn's answer. The follow-up turn
// the result starts writes its question as a `bg` row, and while its rounds are tool
// calls only its rows are steps — never where the reader stops. The answer walk must
// not sail past the landed block to an older answer's first row above it: with the
// list resting at the end (following), the crossing rule would then scroll the reader
// up onto that row — to the block — and freeze them there (chat-spec.md, "A long
// answer stops at its first row": never a row from before the turn's question).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptedConfigPath, hostStateDir, resetSessionConfig, unguardConfigFiles } from '../config/load.ts';
import { ScriptedModel, bootApp, firstUser, settle, settleUntil } from './helpers/scripted';

import { nativeFetch } from './helpers/test-setup.ts';
const realFetch = nativeFetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  unguardConfigFiles();
  resetSessionConfig();
  fs.rmSync(path.join(hostStateDir(), 'config.local.json'), { force: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
});

type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }

// One list item per row, so a line of the answer is exactly one row of the list.
const items = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `- ${prefix} ${String(from + i).padStart(2, '0')}`).join('\n');

// 35 terminal rows leave the chat window's conversation 20 rows.
const ROWS = 35;
const CONVERSATION_ROWS = 20;

// The conversation's lines, top to bottom: under the window's top border and its
// padding row, above the status or hint line, the field and the rows around them.
function conversation(frame: string): string[] {
  const lines = frame.split('\n');
  const top = lines.findIndex((l) => l.includes('╭'));
  const bottom = lines.findIndex((l) => l.includes('╰'));
  const rows = lines.slice(top + 2, bottom - 5).map((l) => l.replace(/^\s*│/, '').replace(/│\s*$/, '').replace(/\s*↓( new)?\s*$/, '').trimEnd());
  expect(rows).toHaveLength(CONVERSATION_ROWS);
  return rows;
}

// The row under the pinned question: the pin paints the question over the box's top
// row and is not a row of the conversation itself.
function topRow(frame: string, question: string): string {
  const rows = conversation(frame);
  return rows[0]!.includes(`› ${question}`) ? rows[1]! : rows[0]!;
}

test('a follow-up turn of a landed result never scrolls the reader up to the block', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sub-scroll-'));
  const model = new ScriptedModel();
  const child = model.when((req) => firstUser(req).includes('FIND-ME'));
  child.script([{ hold: true }, { text: items('result line', 1, 30) }]);
  model.script(
    // The person's question: a short answer, so the list rests at the end and keeps
    // following it — the state the landing and the follow-up turn arrive into.
    [{ text: items('answer one', 1, 3) }],
    // The follow-up turn of the landed result: its first round is a tool call only.
    [{ tool: 'datetime', args: {} }],
    // The next round is held: the turn has drawn its step rows and no text yet.
    [{ hold: true }, { text: 'looked it up' }],
  );
  const ui = await bootApp(model, 140, ROWS, undefined, {
    sessions: { dir }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: true },
  }, { toastMs: 10_000 });
  await ui.press('F');

  await ask(ui, 'first question');
  await settleUntil(() => frameOf(ui).includes('answer one 03'));

  // A subagent runs beside the chat and its result lands under the conversation; the
  // landing starts the follow-up turn.
  await ask(ui, '/subagent FIND-ME the failing test');
  await settleUntil(() => child.held);
  child.release();
  await settleUntil(() => frameOf(ui).includes('result line 30'));
  // The landing is followed: the block's tail is what the reader sees at the end.
  expect(topRow(frameOf(ui), 'first question')).toContain('result line');

  // The follow-up turn is writing its tool round. Its rows are steps — never where
  // the reader stops — so the walk finds nothing of this turn and must find nothing
  // of what came before the landed block either. The reader rests where the landing
  // left them; the old answer's rows must not come back to the top.
  await settle(40);
  const top = topRow(frameOf(ui), 'first question');
  expect(top).not.toContain('answer one');
  expect(top).toContain('result line');

  model.release();
  await settleUntil(() => frameOf(ui).includes('looked it up'));
  expect(topRow(frameOf(ui), 'first question')).not.toContain('answer one');
  ui.app.unmount();
}, 30_000);
