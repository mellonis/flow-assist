// A turn drawn in TIME ORDER. A round's text stays where it was drawn; the one that
// turns out to carry a tool call is a step — in `step` it folds into its run's one row,
// in `open` it keeps its rows in the normal colour — and the final round is the answer.
// Nothing a round drew ever moves above a later part of the turn: jumping it into
// a "kept" slot above EVERY diff of the turn would leave the screen with a tall diff.
// Driven through the real chat on the scripted model — one model round per scripted
// turn, so a turn that ends in a tool call is a step and the last one is the answer.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle, type Turn } from './helpers/scripted';
import type { Make } from '../loader/plugin';
import { SESSION_VERSION, newSessionId, type Session } from '../assistant/sessions.ts';
import { hereHome, hereProject, sessionFiles } from './helpers/session-files';

import { nativeFetch } from './helpers/test-setup.ts';
const realFetch = nativeFetch;
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
    tools: [{ type: 'function', function: { name: 'edit_app', description: 'Edit app.ts.', parameters: { type: 'object', properties: { b: { type: 'number' }, file: { type: 'string' }, content: { type: 'string' } } } } }],
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
  // It carried a call: the stretch stands for it on the same row, and its run is one
  // line with no count — only a run of several steps says how many.
  expect(rowOf(ui, '+ 1 tool')).toBe(first);
  await click(ui, first);
  const oneStep = rows(ui)[rowOf(ui, '▸ I will change b to 42.')] ?? '';
  expect(oneStep).toContain('▸ I will change b to 42.');
  expect(oneStep).not.toContain('step');
  const diff = rowOf(ui, '✎ clone/app.ts');
  expect(diff).toBeGreaterThan(first);
  const second = rowOf(ui, 'Let me check the rest');
  expect(second).toBeGreaterThan(diff);
  model.release();
  await settle(20);
  // Two steps with nothing between them are one run: the stretch stands where the run
  // began, and opened, the run's own row says the newest step and how many there are.
  const run = rowOf(ui, '+ 2 tools');
  expect(run).toBe(second);
  await click(ui, run);
  expect(rows(ui)[run]).toContain('▾ + 2 tools');
  expect(rowOf(ui, '▸ All clear, nothing else uses b.  (2 steps)')).toBe(run + 1);
  expect(ui.backend.lastFrame).not.toContain('Let me check the rest');
  // Nothing above it moved.
  expect(rowOf(ui, '+ 1 tool')).toBe(first);
  expect(rowOf(ui, '✎ clone/app.ts')).toBe(diff);
  model.release();
  await settle(20);
  // The stretch opened a moment ago stays open, the run's row with it.
  expect(rowOf(ui, '▸ All clear, nothing else uses b.  (2 steps)')).toBe(run + 1);
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
  // Which rounds survive must not depend on how the network cuts the stream: read
  // before its own state update has run, a round would be lost, and the NEXT one
  // taken for the step it had been.
  expect(ui.backend.lastFrame).toContain('▸ + 1 tool');
  await click(ui, rowOf(ui, '▸ + 1 tool'));
  expect(ui.backend.lastFrame).toContain('▸ I will look in the notebook now.');
  expect(rowOf(ui, 'Three entries.')).toBeGreaterThan(rowOf(ui, 'I will look in the notebook now.'));
  expect(rows(ui)[rowOf(ui, 'Three entries.')]).toMatch(/│ ƒ Three entries\./);
  expect(cellOn(ui, 'Three entries.').dim).toBeFalsy();
  ui.app.unmount();
});

test('a Next: line is its step without the token — streaming, folded, opened and in open', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [
    [{ text: 'Next: read app.ts' }, { hold: true }, { tool: 'datetime', args: {} }],
    [{ text: 'Nex' }, { hold: true }, { text: 't: count the entries\nThe notebook has a header.' }, { tool: 'datetime', args: {} }],
    [{ text: 'Three entries.' }],
  ]);
  const seen: string[] = [ui.backend.lastFrame];
  expect(ui.backend.lastFrame).toContain('read app.ts'); // streaming, the token already gone
  model.release();
  await settle(20);
  seen.push(ui.backend.lastFrame); // `Nex` held back until it says what it is
  model.release();
  await settle(20);
  seen.push(ui.backend.lastFrame);
  // Opened, the run's row says the newest step; opened further, both are there,
  // token-less.
  expect(ui.backend.lastFrame).toContain('+ 2 tools');
  await click(ui, rowOf(ui, '+ 2 tools'));
  expect(ui.backend.lastFrame).toContain('▸ The notebook has a header.  (2 steps)');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  seen.push(ui.backend.lastFrame);
  expect(ui.backend.lastFrame).toContain('read app.ts');
  expect(ui.backend.lastFrame).toContain('count the entries');
  await ui.type('/notes open');
  await ui.press('return');
  await settle(6);
  seen.push(ui.backend.lastFrame);
  for (const frame of seen) {
    expect(frame).not.toContain('Next');
    expect(frame).not.toContain('Nex');
  }
  ui.app.unmount();
});

test('a step that is only its Next: line folds to that sentence', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [[{ text: 'Next: read app.ts' }, { tool: 'datetime', args: {} }], [{ text: 'Read.' }]]);
  expect(ui.backend.lastFrame).toContain('▸ + 1 tool');
  await click(ui, rowOf(ui, '▸ + 1 tool'));
  expect(ui.backend.lastFrame).toContain('▸ read app.ts');
  expect(ui.backend.lastFrame).not.toContain('Next:');
  ui.app.unmount();
});

test('the answer is drawn as the model wrote it — its own Next: line included', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [[{ text: 'The config is fixed.\n\nNext: restart the server.' }]]);
  expect(ui.backend.lastFrame).toContain('Next: restart the server.');
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
  const stretches = rows(ui).map((r, i) => (r.includes('+ 2 tools') ? i : -1)).filter((i) => i >= 0);
  expect(stretches).toHaveLength(2);
  const [one, two] = stretches;
  const diff = rowOf(ui, '✎ clone/app.ts');
  expect(one).toBeGreaterThan(-1);
  expect(two).toBeGreaterThan(one!);
  expect(diff).toBeGreaterThan(one!);
  expect(diff).toBeLessThan(two!);
  expect(rowOf(ui, '✎ clone/app.test.ts')).toBeGreaterThan(two!);

  // A click on the second stretch opens its run's row alone, in place; a click on that
  // row opens its steps in full, dim.
  await click(ui, two!);
  expect(ui.backend.lastFrame).toContain('▸ Then the tests.  (2 steps)');
  expect(ui.backend.lastFrame).not.toContain('First I read it.');
  await click(ui, rowOf(ui, '▸ Then the tests.  (2 steps)'));
  expect(ui.backend.lastFrame).not.toContain('First I read it.');
  expect(rowOf(ui, 'Now I read it again.')).toBeGreaterThan(diff);
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
  // …and again: every stretch folded.
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  expect(times(ui.backend.lastFrame, '+ 2 tools')).toBe(2);
  ui.app.unmount();
});

test('a drag copies the answer, never a run\'s row', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, TWO_RUNS);
  // The last run's own row is visible once its stretch is opened — the drag starts on
  // that row, so the assertion below is about a row really on screen.
  const last = rows(ui).map((r, i) => (r.includes('+ 2 tools') ? i : -1)).filter((i) => i >= 0).at(-1)!;
  await click(ui, last);
  const from = rowOf(ui, '▸ Then the tests.  (2 steps)');
  expect(from).toBeGreaterThan(-1);
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

// ─── Calls, where they were made ─────────────────────────────────────────────
// A step's own calls are in its run; calls no step made (a round that wrote nothing)
// are a trail line of their own, where they happened — between the runs.
const WITH_READS: Turn[] = [
  [{ text: 'First I look.' }, { tool: 'datetime', args: {} }],
  [{ text: 'Then I look again.' }, { tool: 'datetime', args: {} }],
  [{ tool: 'config_schema', args: {} }, { tool: 'config_schema', args: {} }],
  [{ text: 'Now I change it.' }, { tool: 'edit_app', args: { b: 42 } }],
  [{ text: 'Done.' }],
];

test('calls no step made stand between the runs, in order; a click opens one, ^o all', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, WITH_READS);
  // One stretch holds the runs and the calls no step made, in the order they happened.
  expect(rowOf(ui, '+ 5 tools')).toBeGreaterThan(-1);
  await click(ui, rowOf(ui, '+ 5 tools'));
  const run = rowOf(ui, '▸ Then I look again.  (2 steps)');
  const reads = rows(ui).findIndex((r) => r.includes('⌁ config_schema · ok'));
  const change = rowOf(ui, '▸ Now I change it.');
  expect(run).toBeGreaterThan(-1);
  expect(reads).toBeGreaterThan(run);
  expect(change).toBeGreaterThan(reads);
  expect(rowOf(ui, '✎ clone/app.ts')).toBeGreaterThan(change);
  expect(rowOf(ui, 'Done.')).toBeGreaterThan(rowOf(ui, '✎ clone/app.ts'));
  // The trail sits where the call was made, never under the answer.
  expect(times(ui.backend.lastFrame, '⌁ config_schema · ok')).toBe(2);

  // A click on a call opens that record alone: what it answered, under it, and no
  // other body out.
  await click(ui, reads);
  expect(times(ui.backend.lastFrame, '→ ok')).toBe(1);
  expect(ui.backend.lastFrame).toContain('(2 steps)');
  await click(ui, rowOf(ui, '⌁ config_schema · ok'));
  expect(ui.backend.lastFrame).not.toMatch(/→ ok/);

  // ^o: every record's line, then every record's body — the runs' own calls included.
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  const all = ui.backend.lastFrame;
  expect(times(all, '⌁ datetime · ok')).toBe(2);
  expect(rowOf(ui, 'First I look.')).toBeLessThan(rowOf(ui, '⌁ config_schema · ok'));
  expect(rowOf(ui, '⌁ edit_app · ok')).toBeLessThan(rowOf(ui, '✎ clone/app.ts'));
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  expect(times(ui.backend.lastFrame, '→ ok')).toBe(5);
  expect(ui.backend.lastFrame).toContain('→ ok — edited');
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
    expect(ui.backend.lastFrame).toContain('▸ + 2 tools');
    ui.app.unmount();
  }
  const model = new ScriptedModel();
  const ui = await ask(model, TWO_RUNS, { plugins: { assistant: { notes: 'open' } } });
  expect(ui.backend.lastFrame).not.toContain('(2 steps)');
  await ui.type('/notes step');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('+ 2 tools');
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
  expect(ui.backend.lastFrame).not.toContain('+ 2 tools');
  // /resume opens another conversation, and it brings the config's answer with it.
  await ui.type('/notes step');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('+ 2 tools');
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

test('Esc on a round that began with its Next: plan keeps it as a step — the text does not change', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [[{ text: 'Next: read the file.' }, { hold: true }, { tool: 'datetime', args: {} }]]);
  const y = rowOf(ui, 'read the file.');
  expect(y).toBeGreaterThan(-1);
  await ui.press('escape');
  await settleUntil(() => ui.backend.lastFrame.includes('stopped (Esc)'));
  expect(rows(ui)[y]).toContain('▸ read the file.');
  expect(ui.backend.lastFrame).not.toContain('Next');
  expect(answerMarks(ui)).toBe(0);
  ui.app.unmount();
});

test('a folded run says a call in it failed', async () => {
  const model = new ScriptedModel();
  const ui = await ask(model, [[{ text: 'I try the tool.' }, { tool: 'no_such_tool', args: {} }], [{ text: 'It is not there.' }]]);
  const row = rows(ui)[rowOf(ui, '+ 1 tool')] ?? '';
  expect(row).toContain('✗');
  ui.app.unmount();
});

test('a call keeps what its trail line draws — never a 200 KB argument in the session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-turn-args-'));
  const model = new ScriptedModel();
  const big = 'x'.repeat(200_000);
  const ui = await ask(model, [[{ text: 'I write it.' }, { tool: 'edit_app', args: { b: 42, content: big } }], [{ text: 'Written.' }]], { sessions: { dir } });
  await ui.press('escape', 'escape'); // closing the chat saves at once
  ui.app.unmount();
  const file = sessionFiles(dir)[0]!;
  // The screen's list — the model's own history (`api`) keeps the call as it was
  // made, which it must: the model is sent it next turn.
  const screen = JSON.stringify((JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session).messages);
  expect(screen.length).toBeLessThan(5_000);
  expect(screen).not.toContain('x'.repeat(200));
  expect(screen).toContain('edit_app');
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
  const file = sessionFiles(dir)[0]!;
  const saved = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session;
  const turn = saved.messages.find((m) => Array.isArray(m.parts)) as { parts: { kind: string }[] } & Record<string, unknown>;
  expect(turn.parts.map((p) => p.kind)).toEqual(['text', 'tools', 'text', 'tools', 'change', 'text', 'tools', 'text', 'tools', 'change']);
  for (const old of ['shown', 'process', 'changes', 'toolRuns', 'step', 'live', 'liveQuiet']) expect(old in turn).toBe(false);
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
      // A session written by an older host: the narration of the tool rounds, the part
      // of it that was on screen, the one-line step, every change of the turn, the answer.
      { role: 'assistant', content: 'Old answer.', process: 'I looked at the old file.', shown: 'I looked at the old file.', step: 'look', changes: [change, { title: 7 }],
        toolRuns: [{ name: 'read_file', args: { path: 'old.ts' }, outcome: 'ok', detail: 'const b = 2;' }, { name: 'edit_file', args: {}, write: true, outcome: 'applied', detail: 'ok', changes: [change] }, 'junk'], duration: 1200 },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'Second answer.', parts: 'garbage' },
      { role: 'user', content: 'third question' },
      // A trail after a step with no diff between: its own row, not the step's calls. A
      // call that left a view is drawn by the view — never a second time here.
      { role: 'assistant', content: 'Third answer.', process: 'Third step.', toolRuns: [{ name: 'list_dir', outcome: 'ok' }, { name: 'run_command', outcome: 'ok', views: [{ kind: 'console' }] }] },
      null as never,
      'stray' as never,
    ],
    api: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'Old answer.' }],
    summary: '', plan: [], usage: null, prompts: [], draft: '', project: hereProject(),
  };
  // Written as a file on disk, not through saveSession: this is what a hand edit or an
  // older host may have left, and saving is not what is being tested.
  fs.mkdirSync(hereHome(dir), { recursive: true });
  fs.writeFileSync(path.join(hereHome(dir), `${id}.json`), JSON.stringify(s), { mode: 0o600 });
  const model = new ScriptedModel();
  const ui = await bootApp(model, 100, 40, undefined, { sessions: { dir } });
  await ui.press('F');
  await settle(6);
  // Converted to parts in the old order: the text, then the changes; the step line,
  // the `Next:` and the change that was not one are gone.
  const text = rowOf(ui, '▸ I looked at the old file.');
  expect(text).toBeGreaterThan(-1);
  expect(rowOf(ui, '✎ clone/old.ts')).toBeGreaterThan(text);
  // The trail that was drawn under the answer is one stretch's line just before it —
  // once; its calls are the members opened under it.
  const trail = rowOf(ui, '+ 1 edit, 1 read');
  expect(trail).toBeGreaterThan(rowOf(ui, '✎ clone/old.ts'));
  expect(rowOf(ui, 'Old answer.')).toBeGreaterThan(trail);
  await click(ui, trail);
  expect(times(ui.backend.lastFrame, 'read_file')).toBe(1);
  expect(ui.backend.lastFrame).not.toContain('Next:');
  expect(ui.backend.lastFrame).toContain('Second answer.');
  const third = rowOf(ui, 'third question');
  const step3 = rows(ui).findIndex((r, i) => i > third && r.includes('+ 1 read'));
  expect(step3).toBeGreaterThan(third);
  await click(ui, step3);
  const run3 = rowOf(ui, '▸ Third step.');
  const trail3 = rowOf(ui, '⌁ list_dir · ok');
  expect(run3).toBeGreaterThan(-1);
  expect(trail3).toBeGreaterThan(run3);
  expect(rowOf(ui, 'Third answer.')).toBeGreaterThan(trail3);
  expect(ui.backend.lastFrame).not.toContain('run_command');
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
