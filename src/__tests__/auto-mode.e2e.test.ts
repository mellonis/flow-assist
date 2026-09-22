// The auto mode: how much of a turn runs without the person's y/n, per conversation.
// What matters is that it is never a hidden state (the hint line says it, mid-answer
// too), that it never covers run_command or a web_fetch the allowlist does not cover,
// and that it is gone after /clear, /resume and a restart.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import type { Make } from '../loader/plugin';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 100) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
// A fenced block is drawn as rows behind a dim `│ `; strip the bar to read the lines.
const screen = (frame: string) => frame.split('\n').map((r) => r.replace(/│ /g, '')).join('\n');
// What the chat SAYS the mode is: the hint line inside the window, not the toast that
// announces a change (that one is outside the frame and fades).
function shownMode(frame: string): string | null {
  const inWindow = frame.split('\n').filter((r) => r.trimStart().startsWith('│')).join('\n');
  return /auto: (reads|writes)/.exec(inWindow)?.[1] ?? null;
}

// A guest with one read and one write — the write reports what it changed, so the ✎
// block is there to look for after a call that ran under the mode.
const notebook = (make: Make) => make('notes', {
  tools: [{
    id: 'notes',
    tools: [
      { type: 'function', function: { name: 'notes_read', description: 'Read the notebook.', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'notes_write', description: 'Write the notebook.', parameters: { type: 'object', properties: { text: { type: 'string' } } } }, write: true },
    ],
    exec: async (name: string, args: Record<string, unknown>, ctx: Record<string, unknown>) => {
      if (name === 'notes_read') return 'water the plants';
      (ctx as { reportChange?: (c: unknown) => void }).reportChange?.({ title: 'notes', before: 'water the plants\n', after: `${String(args.text)}\n` });
      return 'notes_write: written';
    },
  }],
} as never);

const boot = (model: ScriptedModel, extra: Record<string, unknown> = {}) =>
  bootApp(model, 110, 30, (make) => [notebook(make)], extra);

// Shift+Tab is a key with a modifier — `press` takes names only.
async function stepAuto(ui: Awaited<ReturnType<typeof boot>>, times = 1) {
  for (let i = 0; i < times; i++) { ui.backend.press({ name: 'tab', shift: true }); await settle(); }
}

test('reads: a read runs by itself, a write still stops — and the hint line says the mode', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'notes_read', args: {} }, { tool: 'notes_write', args: { text: 'water them twice' } }],
    [{ text: 'Done.' }],
  );
  const ui = await boot(model);
  await ui.press('F');
  expect(shownMode(ui.backend.lastFrame)).toBeNull(); // every conversation starts on ask
  await stepAuto(ui);
  expect(shownMode(ui.backend.lastFrame)).toBe('reads');

  await ui.type('read the notes, then rewrite them');
  await ui.press('return');
  await settle(10);
  // The read never asked; the write did, and nothing reached the notebook yet.
  expect(ui.backend.lastFrame).toContain('Confirm write: notes_write');
  expect(shownMode(ui.backend.lastFrame)).toBe('reads'); // still said, mid-turn
  await ui.press('n');
  await settleUntil(() => model.requests.length === 2);
  const sent = JSON.stringify(model.requests[1]!.messages);
  expect(sent).toContain('OK: water the plants');
  expect(sent).toContain('DECLINED');
  ui.app.unmount();
});

test('all: the write runs without asking, and what it changed is still shown', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'notes_write', args: { text: 'water them twice' } }],
    [{ text: 'Rewritten.' }],
  );
  const ui = await boot(model);
  await ui.press('F');
  await stepAuto(ui, 2);
  expect(shownMode(ui.backend.lastFrame)).toBe('writes');

  await ui.type('rewrite the notes');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  expect(ui.backend.lastFrame).not.toContain('Confirm write');
  const shown = screen(ui.backend.lastFrame);
  expect(shown).toContain('✎ notes · +1 −1');
  expect(shown).toContain('+water them twice');
  expect(shown).toContain('Rewritten.');
  expect(JSON.stringify(model.requests[1]!.messages)).toContain('OK: notes_write: written');
  ui.app.unmount();
});

test('the mode is on screen while an answer is coming, not only between turns', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Thinking' }, { hold: true }, { text: ' about it.' }]);
  const ui = await boot(model);
  await ui.press('F');
  await stepAuto(ui, 2);
  await ui.type('hello');
  await ui.press('return');
  await settle(6);
  // The left cell now holds the running turn's status, where the hint was.
  expect(ui.backend.lastFrame).toContain('stops');
  expect(shownMode(ui.backend.lastFrame)).toBe('writes');
  model.release();
  await settle(10);
  ui.app.unmount();
});

test('run_command and an unlisted web_fetch ask in every mode', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'rm -rf /tmp/whatever' } }],
    [{ text: 'Not run.' }],
    [{ tool: 'web_fetch', args: { url: 'https://example.com/page' } }],
    [{ text: 'Not fetched.' }],
  );
  const ui = await boot(model);
  await ui.press('F');
  await stepAuto(ui, 2); // all — the loudest mode there is
  await ui.type('clean up');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Confirm write: run_command');
  expect(ui.backend.lastFrame).toContain('$ rm -rf /tmp/whatever'); // the line itself, not its JSON
  await ui.press('n');
  await settleUntil(() => model.requests.length === 2);

  await ui.type('read example.com');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Confirm write: web_fetch');
  await ui.press('n');
  await settleUntil(() => model.requests.length === 4);
  expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain('DECLINED');
  ui.app.unmount();
});

test('/auto sets and names the mode, and a word it does not know changes nothing', async () => {
  const model = new ScriptedModel();
  const ui = await boot(model);
  await ui.press('F');
  await ui.type('/auto all');
  await ui.press('return');
  expect(shownMode(ui.backend.lastFrame)).toBe('writes');
  await ui.type('/auto off');
  await ui.press('return');
  expect(shownMode(ui.backend.lastFrame)).toBeNull();
  await ui.type('/auto sideways');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('/auto takes reads, all or off');
  expect(shownMode(ui.backend.lastFrame)).toBeNull();
  ui.app.unmount();
});

test('/clear and /resume come back to ask', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-auto-'));
  const model = new ScriptedModel();
  model.script([{ text: 'first answer' }]);
  const ui = await boot(model, { sessions: { dir } });
  await ui.press('F');
  await ui.type('first question');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  await settle(10);

  await stepAuto(ui, 2);
  expect(shownMode(ui.backend.lastFrame)).toBe('writes');
  await ui.type('/clear');
  await ui.press('return');
  expect(shownMode(ui.backend.lastFrame)).toBeNull();

  // …and a conversation opened from the list is another conversation, mode included.
  await stepAuto(ui);
  expect(shownMode(ui.backend.lastFrame)).toBe('reads');
  await ui.type('/resume 1');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('first question');
  expect(shownMode(ui.backend.lastFrame)).toBeNull();
  ui.app.unmount();
});

test('a restart comes back to ask, and the session file never held the mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-auto-'));
  const model = new ScriptedModel();
  model.script([{ text: 'first answer' }]);
  const ui = await boot(model, { sessions: { dir } });
  await ui.press('F');
  await ui.type('first question');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  await settle(10);
  await stepAuto(ui, 2);
  expect(shownMode(ui.backend.lastFrame)).toBe('writes');
  await new Promise((r) => setTimeout(r, 350)); // the debounced save
  const saved = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  expect(saved).toHaveLength(1);
  expect(fs.readFileSync(path.join(dir, saved[0]!), 'utf8')).not.toContain('auto');
  ui.app.unmount();

  const again = new ScriptedModel();
  again.script([{ text: 'second answer' }]);
  const back = await bootApp(again, 110, 30, (make) => [notebook(make)], { sessions: { dir } });
  await settle(6);
  await back.press('F');
  expect(back.backend.lastFrame).toContain('first question'); // the conversation did come back
  expect(shownMode(back.backend.lastFrame)).toBeNull(); // the mode did not
  back.app.unmount();
});
