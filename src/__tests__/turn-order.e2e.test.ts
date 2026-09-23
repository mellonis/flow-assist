// A turn drawn in TIME ORDER. A round's text stays where it was drawn; the one that
// turns out to carry a tool call is a step — in `step` it folds into its run's one row,
// in `open` it keeps its rows in the normal colour — and the final round is the answer.
// Nothing a round drew ever moves above a later part of the turn: it used to jump into
// a "kept" slot above EVERY diff of the turn, and with a tall diff it left the screen.
// Driven through the real chat on the scripted model — one model round per scripted
// turn, so a turn that ends in a tool call is a step and the last one is the answer.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle, type Turn } from './helpers/scripted';
import type { Make } from '../loader/plugin';
import { SESSION_VERSION, newSessionId, type Session } from '../assistant/sessions.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Ui = Awaited<ReturnType<typeof bootApp>>;

const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const rows = (ui: Ui) => ui.backend.lastFrame.split('\n');
const rowOf = (ui: Ui, needle: string) => rows(ui).findIndex((r) => r.includes(needle));
const times = (frame: string, needle: string) => frame.split(needle).length - 1;
// The answer's mark in the conversation's gutter — `ƒ` right after the window's left
// border. The frame's own title (`╭─ ƒ Flow Assist`) is not a row of the conversation.
const answerMarks = (ui: Ui) => rows(ui).filter((r) => /^\s*│ ƒ /.test(r)).length;
// The style of the cell a piece of text starts on, read from the buffer as it stands
// NOW — `lastBuffer` is a snapshot, so it is taken again after every change.
function cellOn(ui: Ui, needle: string): { dim?: boolean; fg?: string } {
  const all = rows(ui);
  const y = all.findIndex((r) => r.includes(needle));
  if (y < 0) throw new Error(`"${needle}" is not on screen:\n${ui.backend.lastFrame}`);
  const x = Array.from(all[y]!.slice(0, all[y]!.indexOf(needle))).length;
  return (ui.backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { dim?: boolean; fg?: string } } } }).lastBuffer.get(x, y).style;
}
async function click(ui: Ui, y: number) {
  ui.backend.mouse('down', 12, y);
  ui.backend.mouse('up', 12, y);
  await settle(6);
}

// A guest whose one tool edits a file and reports the change — so a turn has a ✎ block
// in it. No `write` flag: these tests are about the turn, not the y/n.
const editor = (make: Make) => [make('clone', {
  tools: [{
    id: 'clone',
    tools: [{ type: 'function', function: { name: 'edit_app', description: 'Edit app.ts.', parameters: { type: 'object', properties: { b: { type: 'number' } } } } }],
    exec: async (_name: string, args: Record<string, unknown>, ctx: Record<string, unknown>) => {
      (ctx as { reportChange?: (c: unknown) => void }).reportChange?.({ title: `clone/app${args.file ?? ''}.ts`, before: 'const a = 1;\nconst b = 2;\n', after: `const a = 1;\nconst b = ${Number(args.b)};\n` });
      return 'edited';
    },
  }],
} as never)] as never;

async function ask(model: ScriptedModel, turns: Turn[], extra: Record<string, unknown> = {}, size: [number, number] = [100, 50]): Promise<Ui> {
  model.script(...turns);
  const ui = await bootApp(model, size[0], size[1], editor, extra);
  await ui.press('F');
  await ui.type('set b to 42');
  await ui.press('return');
  await settle(20);
  return ui;
}

// text → a write → text → a tool → the answer, with a hold in each round of text so a
// frame can be taken while it streams.
const TURN: Turn[] = [
  [{ text: 'I will change b to 42.' }, { hold: true }, { tool: 'edit_app', args: { b: 42 } }],
  [{ text: 'Let me check the rest of the file.' }, { hold: true }, { tool: 'datetime', args: {} }],
  [{ text: 'All clear, nothing else uses b.' }, { tool: 'datetime', args: {} }],
  [{ text: 'Done: b is now ' }, { hold: true }, { text: '42.' }],
];

test('open: every round stays exactly where it was drawn, the text under the diff it followed', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, TURN, { plugins: { assistant: { notes: 'open' } } });
  const at: Record<string, number[]> = {};
  const look = () => { for (const k of ['I will change b', '✎ clone/app.ts', 'Let me check the rest', 'All clear', 'Done: b is now']) (at[k] ??= []).push(rowOf(ui, k)); };
  look(); // round 1 streaming
  model.release();
  await settle(20);
  look(); // the write landed; round 2 streaming
  model.release();
  await settle(20);
  look(); // round 3 done; the answer streaming
  model.release();
  await settle(20);
  look(); // the turn done

  // Each part, once drawn, sits on the same row in every later frame.
  const settled = (k: string) => at[k]!.filter((y) => y >= 0);
  for (const k of Object.keys(at)) expect(new Set(settled(k)).size).toBe(1);
  expect(settled('I will change b')).toHaveLength(4);
  // And the order is the order it happened in.
  const y = (k: string) => settled(k)[0]!;
  expect(y('I will change b')).toBeLessThan(y('✎ clone/app.ts'));
  expect(y('✎ clone/app.ts')).toBeLessThan(y('Let me check the rest'));
  expect(y('Let me check the rest')).toBeLessThan(y('All clear'));
  expect(y('All clear')).toBeLessThan(y('Done: b is now'));
  // `open` draws the steps in the normal colour; the answer is the only `ƒ`.
  expect(cellOn(ui, 'I will change b').dim).toBeFalsy();
  expect(cellOn(ui, 'All clear').dim).toBeFalsy();
  expect(answerMarks(ui)).toBe(1);
  expect(rows(ui)[y('Done: b is now')]).toMatch(/│ ƒ Done: b is now 42\./);
  ui.app.unmount();
});

test('step: a run folds into ONE row where it began — under the diff it followed, and nothing above it moves', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, TURN);
  // Round 1 streams in full, dim, with a live mark and no `ƒ`.
  const first = rowOf(ui, 'I will change b to 42.');
  expect(first).toBeGreaterThan(-1);
  expect(cellOn(ui, 'I will change b').dim).toBe(true);
  expect(answerMarks(ui)).toBe(0);
  model.release();
  await settle(20);
  // It carried a call: it is a run of one now, on the same row — no count.
  expect(rowOf(ui, '▸ I will change b to 42.')).toBe(first);
  expect(rows(ui)[first]).not.toContain('steps)');
  const diff = rowOf(ui, '✎ clone/app.ts');
  expect(diff).toBeGreaterThan(first);
  const second = rowOf(ui, 'Let me check the rest');
  expect(second).toBeGreaterThan(diff);
  model.release();
  await settle(20);
  // Two steps with nothing between them are one run: its row stands where the run
  // began, says the newest step and how many there are.
  const run = rowOf(ui, 'All clear, nothing else uses b.');
  expect(run).toBe(second);
  expect(rows(ui)[run]).toContain('▸ All clear, nothing else uses b.  (2 steps)');
  expect(ui.backend.lastFrame).not.toContain('Let me check the rest');
  // Nothing above it moved.
  expect(rowOf(ui, '▸ I will change b to 42.')).toBe(first);
  expect(rowOf(ui, '✎ clone/app.ts')).toBe(diff);
  model.release();
  await settle(20);
  expect(rowOf(ui, '(2 steps)')).toBe(run);
  expect(rowOf(ui, 'Done: b is now 42.')).toBeGreaterThan(run);
  expect(cellOn(ui, 'Done: b is now').dim).toBeFalsy();
  ui.app.unmount();
});

test('the answer gets its ƒ only once its round has ended — never a round that turns out to call a tool', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, TURN);
  // Every frame while a round that will call a tool is streaming: no `ƒ` anywhere.
  expect(answerMarks(ui)).toBe(0);
  model.release();
  await settle(20);
  expect(answerMarks(ui)).toBe(0);
  model.release();
  await settle(20);
  // The final round, mid-stream: still not known to be the answer.
  expect(ui.backend.lastFrame).toContain('Done: b is now');
  expect(answerMarks(ui)).toBe(0);
  expect(cellOn(ui, 'Done: b is now').dim).toBe(true);
  const y = rowOf(ui, 'Done: b is now');
  model.release();
  await settle(20);
  // It ended with no call: the same row, `ƒ` and the normal colour.
  expect(answerMarks(ui)).toBe(1);
  expect(rowOf(ui, 'Done: b is now 42.')).toBe(y);
  expect(cellOn(ui, 'Done: b is now').dim).toBeFalsy();
  ui.app.unmount();
});

test('a round whose text and tool call arrive in ONE chunk keeps its text — and the next round is still the answer', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [
    [{ text: 'I will look in the notebook now.', tool: 'datetime', args: {} }],
    [{ text: 'Three entries.' }],
  ]);
  // Which rounds survived used to depend on how the network cut the stream: read
  // before its own state update had run, this round was lost, and the NEXT one was
  // taken for the step it had been.
  expect(ui.backend.lastFrame).toContain('▸ I will look in the notebook now.');
  expect(rowOf(ui, 'Three entries.')).toBeGreaterThan(rowOf(ui, 'I will look in the notebook now.'));
  expect(rows(ui)[rowOf(ui, 'Three entries.')]).toMatch(/│ ƒ Three entries\./);
  expect(cellOn(ui, 'Three entries.').dim).toBeFalsy();
  ui.app.unmount();
});

test('a Next: line is never drawn — not while it streams, not after, not opened', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [
    [{ text: 'Next: read the notebook.' }, { hold: true }, { tool: 'datetime', args: {} }],
    [{ text: 'Nex' }, { hold: true }, { text: 't: count the entries\nThe notebook has a header.' }, { tool: 'datetime', args: {} }],
    [{ text: 'Three entries.' }],
  ]);
  const seen: string[] = [ui.backend.lastFrame];
  model.release();
  await settle(20);
  seen.push(ui.backend.lastFrame); // `Nex` held back until it says what it is
  model.release();
  await settle(20);
  seen.push(ui.backend.lastFrame);
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  seen.push(ui.backend.lastFrame);
  await ui.type('/notes open');
  await ui.press('return');
  await settle(6);
  seen.push(ui.backend.lastFrame);
  for (const frame of seen) {
    expect(frame).not.toContain('Next');
    expect(frame).not.toContain('Nex');
    expect(frame).not.toContain('read the notebook');
    expect(frame).not.toContain('count the entries');
  }
  // What the round said besides its `Next:` line is a step like any other.
  expect(ui.backend.lastFrame).toContain('The notebook has a header.');
  expect(ui.backend.lastFrame).toContain('Three entries.');
  ui.app.unmount();
});

// ─── Runs fold on their own ──────────────────────────────────────────────────
const TWO_RUNS: Turn[] = [
  [{ text: 'First I read it.' }, { tool: 'datetime', args: {} }],
  [{ text: 'Now I change it.' }, { tool: 'edit_app', args: { b: 42 } }],
  [{ text: 'Now I read it again.' }, { tool: 'datetime', args: {} }],
  [{ text: 'Then the tests.' }, { tool: 'edit_app', args: { b: 43, file: '.test' } }],
  [{ text: 'Done.' }],
];

test('two runs split by a diff fold on their own: a click opens one, ^o opens both, and back', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, TWO_RUNS);
  const one = rowOf(ui, '▸ Now I change it.  (2 steps)');
  const two = rowOf(ui, '▸ Then the tests.  (2 steps)');
  expect(one).toBeGreaterThan(-1);
  expect(two).toBeGreaterThan(one);
  expect(one).toBeGreaterThan(-1);
  expect(rowOf(ui, '✎ clone/app.ts')).toBeGreaterThan(one);
  expect(rowOf(ui, '✎ clone/app.ts')).toBeLessThan(two);
  expect(rowOf(ui, '✎ clone/app.test.ts')).toBeGreaterThan(two);

  // A click on the second run opens it alone, in place: its steps in full, dim.
  await click(ui, two);
  expect(ui.backend.lastFrame).toContain('▸ Now I change it.  (2 steps)');
  expect(ui.backend.lastFrame).not.toContain('First I read it.');
  expect(rowOf(ui, 'Now I read it again.')).toBeGreaterThan(rowOf(ui, '✎ clone/app.ts'));
  expect(rowOf(ui, 'Then the tests.')).toBeGreaterThan(rowOf(ui, 'Now I read it again.'));
  expect(cellOn(ui, 'Now I read it again.').dim).toBe(true);
  // A click on any of its rows folds it back.
  await click(ui, rowOf(ui, 'Now I read it again.'));
  expect(rows(ui)[rowOf(ui, 'Then the tests.')]).toContain('(2 steps)');
  expect(ui.backend.lastFrame).not.toContain('Now I read it again.');

  // ^o: every run at once, each where it happened.
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  const frame = ui.backend.lastFrame;
  expect(frame).not.toContain('(2 steps)');
  for (const s of ['First I read it.', 'Now I change it.', 'Now I read it again.', 'Then the tests.']) expect(frame).toContain(s);
  expect(rowOf(ui, 'Now I change it.')).toBeLessThan(rowOf(ui, '✎ clone/app.ts'));
  expect(rowOf(ui, 'Now I read it again.')).toBeGreaterThan(rowOf(ui, '✎ clone/app.ts'));
  // …and again: every run folded.
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  expect(times(ui.backend.lastFrame, '(2 steps)')).toBe(2);
  ui.app.unmount();
});

test('a drag copies the answer, never a run\'s row', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, TWO_RUNS);
  const from = rowOf(ui, 'Then the tests.');
  const to = rowOf(ui, 'Done.');
  ui.backend.mouse('down', 2, from);
  for (let y = from; y <= to; y++) ui.backend.mouse('drag', 90, y);
  ui.backend.mouse('up', 90, to);
  await settle(4);
  const [text] = ui.backend.clipboard;
  expect(text).toContain('Done.');
  expect(text).not.toContain('Then the tests.');
  ui.app.unmount();
});

// ─── The mode ─────────────────────────────────────────────────────────────────
test('/notes open draws every step in the normal colour; step dims them when opened', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, TWO_RUNS);
  await ui.type('/notes open');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).not.toContain('(2 steps)');
  expect(cellOn(ui, 'First I read it.').dim).toBeFalsy();
  // A mode is not a fold: nothing there is clickable, a click folds nothing.
  await click(ui, rowOf(ui, 'First I read it.'));
  expect(ui.backend.lastFrame).toContain('First I read it.');
  await ui.type('/notes step');
  await ui.press('return');
  await settle(6);
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  expect(cellOn(ui, 'First I read it.').dim).toBe(true);
  await ui.type('/notes fold');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('/notes takes step or open');
  ui.app.unmount();
});

test('a config that still says fold or hidden reads as step; /clear comes back to the config', async () => {
  for (const old of ['fold', 'hidden']) {
    const model = new ScriptedModel();
    const ui = await ask(model, TWO_RUNS, { plugins: { assistant: { notes: old } } });
    expect(ui.backend.lastFrame).toContain('▸ Then the tests.  (2 steps)');
    ui.app.unmount();
  }
  const model = new ScriptedModel();
  const ui = await ask(model, TWO_RUNS, { plugins: { assistant: { notes: 'open' } } });
  expect(ui.backend.lastFrame).not.toContain('(2 steps)');
  await ui.type('/notes step');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('(2 steps)');
  await ui.type('/clear');
  await ui.press('return');
  await settle(10);
  model.script(...TWO_RUNS);
  await ui.type('and again');
  await ui.press('return');
  await settle(30);
  // Back to what the config asks for — the mode was this conversation's.
  expect(ui.backend.lastFrame).toContain('Then the tests.');
  expect(ui.backend.lastFrame).not.toContain('(2 steps)');
  // /resume opens another conversation, and it brings the config's answer with it.
  await ui.type('/notes step');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('(2 steps)');
  await ui.type('/resume 2');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Then the tests.');
  expect(ui.backend.lastFrame).not.toContain('(2 steps)');
  ui.app.unmount();
});

test('Esc mid-round keeps what was written where it was — the answer so far, under stopped (Esc)', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [[{ text: 'There are three entries, ' }, { hold: true }, { text: 'all short.' }]]);
  const y = rowOf(ui, 'There are three entries,');
  expect(y).toBeGreaterThan(-1);
  expect(answerMarks(ui)).toBe(0);
  await ui.press('escape');
  await settleUntil(() => ui.backend.lastFrame.includes('stopped (Esc)'));
  // The turn is over, so what it had come to is its answer: the same row, the `ƒ`,
  // the normal colour — and the line under it says it was cut short.
  expect(rowOf(ui, 'There are three entries,')).toBe(y);
  expect(rows(ui)[y]).toMatch(/│ ƒ There are three entries,/);
  expect(cellOn(ui, 'There are three entries,').dim).toBeFalsy();
  expect(ui.backend.lastFrame).toContain('stopped (Esc)');
  ui.app.unmount();
});

test('Esc on a round known to carry a call keeps it as a step', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [[{ tool: 'datetime', args: {} }, { text: 'Now I count them.' }, { hold: true }]]);
  const y = rowOf(ui, 'Now I count them.');
  expect(y).toBeGreaterThan(-1);
  await ui.press('escape');
  await settleUntil(() => ui.backend.lastFrame.includes('stopped (Esc)'));
  expect(rows(ui)[y]).toContain('▸ Now I count them.');
  expect(answerMarks(ui)).toBe(0);
  ui.app.unmount();
});

// ─── Sessions ─────────────────────────────────────────────────────────────────
test('a restart keeps the turn in the order it happened', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-turn-sess-'));
  const first = new ScriptedModel();
  const one = await ask(first, TWO_RUNS, { sessions: { dir } });
  const before = ['First I read it.', '✎ clone/app.ts', 'Then the tests.', '✎ clone/app.test.ts', 'Done.'];
  expect(rowOf(one, 'Done.')).toBeGreaterThan(-1);
  await one.press('escape', 'escape'); // closing the chat saves at once
  one.app.unmount();

  const model = new ScriptedModel();
  const two = await bootApp(model, 100, 50, editor, { sessions: { dir }, plugins: { assistant: { notes: 'open' } } });
  await two.press('F');
  await settle(6);
  const ys = before.map((s) => rowOf(two, s));
  for (const y of ys) expect(y).toBeGreaterThan(-1);
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  // What is saved is the parts, in order — never the category slots.
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'))!;
  const saved = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session;
  const turn = saved.messages.find((m) => Array.isArray(m.parts)) as { parts: { kind: string }[] } & Record<string, unknown>;
  expect(turn.parts.map((p) => p.kind)).toEqual(['text', 'text', 'change', 'text', 'text', 'change']);
  for (const old of ['shown', 'process', 'changes', 'step', 'live', 'liveQuiet']) expect(old in turn).toBe(false);
  two.app.unmount();
});

test('a session saved before the time order still renders — and a malformed message does not break it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-turn-old-'));
  const id = newSessionId();
  const now = new Date().toISOString();
  const change = { title: 'clone/old.ts', diff: '@@ -1 +1 @@\n-const b = 2;\n+const b = 42;', added: 1, removed: 1, hidden: 0 };
  const s: Session = {
    version: SESSION_VERSION, id, title: 'old', createdAt: now, updatedAt: now,
    messages: [
      { role: 'user', content: 'old question' },
      // The category layout: the narration of the tool rounds, the part of it that was
      // on screen, the one-line step, every change of the turn, the answer.
      { role: 'assistant', content: 'Old answer.', process: 'Next: look\n\nI looked at the old file.', shown: 'I looked at the old file.', step: 'look', changes: [change, { title: 7 }], duration: 1200 },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'Second answer.', parts: 'garbage' },
      null as never,
      'stray' as never,
    ],
    api: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'Old answer.' }],
    summary: '', plan: [], usage: null, prompts: [], draft: '',
  };
  // Written as a file on disk, not through saveSession: this is what a hand edit or an
  // older host may have left, and saving is not what is being tested.
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(s), { mode: 0o600 });
  const model = new ScriptedModel();
  const ui = await bootApp(model, 100, 40, undefined, { sessions: { dir } });
  await ui.press('F');
  await settle(6);
  // Converted to parts in the old order: the text, then the changes; the step line,
  // the `Next:` and the change that was not one are gone.
  const text = rowOf(ui, '▸ I looked at the old file.');
  expect(text).toBeGreaterThan(-1);
  expect(rowOf(ui, '✎ clone/old.ts')).toBeGreaterThan(text);
  expect(rowOf(ui, 'Old answer.')).toBeGreaterThan(rowOf(ui, '✎ clone/old.ts'));
  expect(ui.backend.lastFrame).not.toContain('Next:');
  expect(ui.backend.lastFrame).toContain('Second answer.');
  ui.app.unmount();
});

test('the model is asked for one Next: line before a call, and never told to say nothing', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, TWO_RUNS);
  const sent = (model.requests[0]!.messages as { role: string; content?: string }[]).map((m) => String(m.content ?? '')).join('\n');
  expect(sent).toContain('Before you call a tool, write ONE short line that starts with "Next:" and says what you are about to do');
  expect(sent).toContain('Do not begin the final answer with "Next:"');
  expect(sent).not.toContain('think silently');
  ui.app.unmount();
});
