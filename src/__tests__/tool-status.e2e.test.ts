// The status line says what is happening NOW. Reading a stale copy of a tool's label
// in the stream callbacks would leave it showing after the tool finished, so the chat
// would look stuck on the tool while the model is already writing its notes.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const statusRow = (frame: string) => frame.split('\n').find((r) => /Esc stops/.test(r)) ?? '';
// The seconds the status line is showing — of whatever is running now.
const secondsOn = (frame: string) => Number(/(\d+\.\d)s/.exec(statusRow(frame))?.[1] ?? -1);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The word the line says while no tool runs, and what phase its colour says: magenta
// while the model thinks, the assistant's accent (green) while its text arrives. The
// shimmer's highlight passes over a few cells; the rest carry the phase's colour.
type Ui = Awaited<ReturnType<typeof bootApp>>;
function verbOn(ui: Ui): { word: string; phase: 'thinking' | 'writing' | '?' } {
  const rows = ui.backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => /Esc stops/.test(r));
  const m = /([A-Z][a-z]+)…/.exec(rows[y] ?? '');
  if (!m) return { word: '', phase: '?' };
  const x0 = Array.from(rows[y]!.slice(0, m.index)).length;
  const buf = (ui.backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { fg?: string } } } }).lastBuffer;
  const fgs = Array.from(m[1]!).map((_c, i) => buf.get(x0 + i, y).style.fg);
  const phase = fgs.includes('magenta') ? 'thinking' : fgs.includes('green') ? 'writing' : '?';
  return { word: m[1]!, phase };
}
// A real process finishes on its own clock, not the test backend's.
const settleUntil = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};

test('once the tool is done and the model writes, the line says a word in the writing colour, not the tool', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'datetime', args: {} }],
    [{ text: 'Сейчас смотрю, ' }, { hold: true }, { text: 'готово.' }],
  );
  const ui = await bootApp(model, 110, 28);
  await ui.press('F');
  await ui.type('который час?');
  await ui.press('return');
  await settle(20);
  const row = statusRow(ui.backend.lastFrame);
  expect(row).toContain('1 tool call');
  expect(verbOn(ui).phase).toBe('writing');
  expect(row).not.toContain('⚙');
  model.release();
  await settle(20);
  ui.app.unmount();
});

// Between tools nothing is being written: the model is working out its next call.
// Saying "writing…" there instead would read as text that never appears.
test('between tools, before any text, the line is in the thinking colour, not the writing one or the last tool', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'datetime', args: {} }],
    [{ hold: true }, { tool: 'datetime', args: {} }],
    [{ text: 'готово.' }],
  );
  const ui = await bootApp(model, 110, 28);
  await ui.press('F');
  await ui.type('который час?');
  await ui.press('return');
  await settle(20);
  const row = statusRow(ui.backend.lastFrame);
  expect(row).toContain('1 tool call');
  expect(verbOn(ui).phase).toBe('thinking');
  expect(row).not.toContain('⚙');
  model.release();
  await settle(20);
  ui.app.unmount();
});

test('before the first token the line is in the thinking colour', async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'ответ' }]);
  const ui = await bootApp(model, 110, 28);
  await ui.press('F');
  await ui.type('привет');
  await ui.press('return');
  await settle(10);
  expect(verbOn(ui).phase).toBe('thinking');
  model.release();
  await settle(20);
  ui.app.unmount();
});

test('a running tool is drawn bright, not dim — it moves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-toolstatus-'));
  const ui = await bootApp(new ScriptedModel(), 110, 28, undefined, { fs: { roots: [dir] } });
  await ui.press('F');
  await ui.type('!sleep 1');
  await ui.press('return');
  await settle(6);
  const rows = ui.backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes('$ sleep 1') && r.includes('Esc stops'));
  expect(y).toBeGreaterThanOrEqual(0);
  const style = ui.backend.lastBuffer.get(rows[y]!.indexOf('$ sleep 1'), y).style as { fg?: string; dim?: boolean };
  expect(style.dim).toBeFalsy();
  expect(style.fg).toBeTruthy();
  await ui.press('escape');
  await settle(6);
  ui.app.unmount();
});

// ─── the seconds are the RUNNING thing's, and the line says what the turn costs ──

test('the line times the running tool, not the turn, and the clock restarts with the next tool', async () => {
  // One timer from the question to the answer sat at `3m 12s` through a build, which
  // says nothing about what is happening now. The turn's own total stays on the quiet
  // line under the finished answer.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-clock-')));
  const model = new ScriptedModel();
  model.script(
    [{ hold: true }, { tool: 'run_command', args: { command: 'sleep 1' } }, { tool: 'run_command', args: { command: 'echo second' } }],
    [{ text: 'done.' }],
  );
  const ui = await bootApp(model, 110, 28, undefined, { fs: { roots: [root] } });
  await ui.press('F');
  await ui.type('run both');
  await ui.press('return');
  // Nothing is running but the model's round: the seconds are that round's, and they
  // are the oldest number this turn will show.
  await wait(1300);
  await settle(3);
  const round = secondsOn(ui.backend.lastFrame);
  expect(verbOn(ui).phase).toBe('thinking');
  expect(round).toBeGreaterThan(1);

  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  await ui.press('y');
  // Long enough for the line to have ticked: a number read the moment a clock is set
  // is 0 whichever clock it is, and would say nothing.
  await wait(400);
  await settle(3);
  // The first command is running: the line is its, and its seconds are its own — far
  // short of how long the turn has been going.
  const first = secondsOn(ui.backend.lastFrame);
  expect(statusRow(ui.backend.lastFrame)).toContain('run_command');
  expect(first).toBeLessThan(round);

  // The next call starts its own clock, rather than carrying the last one's on.
  await settleUntil(() => ui.backend.lastFrame.includes('echo second'));
  await wait(400);
  await settle(3);
  const second = secondsOn(ui.backend.lastFrame);
  expect(second).toBeLessThan(round);
  expect(second).toBeLessThan(first + 0.5);
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  // And the turn's own total is where it is read afterwards: under the answer.
  expect(ui.backend.lastFrame).toMatch(/│ {3}\d+\.\ds\s/);
  // The two commands are shown by their blocks, and never a second time as calls.
  expect(ui.backend.lastFrame).not.toContain('2 tools');
  ui.app.unmount();
}, 20_000);

test('what the turn costs is on the status line and under the answer — and nothing is invented', async () => {
  const model = new ScriptedModel();
  model.usage = { prompt_tokens: 1000, completion_tokens: 500 };
  model.script(
    [{ tool: 'datetime', args: {} }], // this round reports 1500 tokens
    [{ hold: true }, { text: 'half past two.' }],
  );
  const ui = await bootApp(model, 110, 28);
  await ui.press('F');
  await ui.type('который час?');
  await ui.press('return');
  await settle(20);
  // The second round is held: the figure on the line is what the first round cost.
  expect(statusRow(ui.backend.lastFrame)).toContain('1.5k tok');
  model.release();
  await settle(20);
  // The answer's quiet line carries the whole turn — both rounds.
  expect(ui.backend.lastFrame).toContain('3.0k tok');
  ui.app.unmount();
});

test('a provider that reports no usage shows no figure rather than a guess', async () => {
  const model = new ScriptedModel(); // usage is null: the chunk is never sent
  model.script([{ tool: 'datetime', args: {} }], [{ hold: true }, { text: 'half past two.' }]);
  const ui = await bootApp(model, 110, 28);
  await ui.press('F');
  await ui.type('который час?');
  await ui.press('return');
  await settle(20);
  expect(statusRow(ui.backend.lastFrame)).not.toContain('tok');
  model.release();
  await settle(20);
  expect(ui.backend.lastFrame).toContain('half past two.');
  expect(ui.backend.lastFrame).not.toContain('tok');
  ui.app.unmount();
});

// ─── The word ─────────────────────────────────────────────────────────────────
test('the word is one per request: the same all through a round, another for the next, from ui.verbs when set', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: 'Looking' }, { hold: true }, { text: ' now.' }, { tool: 'datetime', args: {} }],
    [{ text: 'Done' }, { hold: true }, { text: '.' }],
  );
  const verbs = ['Alphaing', 'Betaing'];
  const ui = await bootApp(model, 110, 28, undefined, { ui: { verbs } });
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await settle(10);
  const first = verbOn(ui).word;
  expect(verbs).toContain(first);
  // Re-rendered many times over (the spinner ticks): it never changes within a round.
  for (let i = 0; i < 5; i++) { await wait(40); await settle(2); expect(verbOn(ui).word).toBe(first); }
  model.release();
  await settle(20);
  const second = verbOn(ui).word;
  expect(verbs).toContain(second);
  expect(second).not.toBe(first);
  model.release();
  await settle(20);
  ui.app.unmount();
});

test('without ui.verbs the word comes from the built-in list', async () => {
  const { VERBS } = await import('../assistant/verbs.ts');
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'ok' }]);
  const ui = await bootApp(model, 110, 28);
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await settle(10);
  expect(VERBS).toContain(verbOn(ui).word);
  expect(statusRow(ui.backend.lastFrame)).not.toMatch(/thinking…|writing…/);
  model.release();
  await settle(20);
  ui.app.unmount();
});
