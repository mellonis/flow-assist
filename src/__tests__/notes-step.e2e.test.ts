// The step line: what the model last said it is doing, in ONE dim row instead of the
// folded `▸ notes` header and the last two lines of prose. Driven through the real
// chat on the scripted model — one model round per scripted turn, so a turn that ends
// in a tool call is a round of narration and the last one is the answer.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Ui = Awaited<ReturnType<typeof bootApp>>;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The floor on the step line is a real second, on the wall clock — so a test that
// wants the second sentence waits it out rather than pretending.
const settleUntil = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(25); }
  await settle(2);
};
const times = (frame: string, needle: string) => frame.split(needle).length - 1;

// Two rounds of narration, each ending in a tool call, then the answer.
// No line break at the end of a round: a round IS a chunk, and two chunks put
// together with nothing between them is exactly what used to glue the sentences.
const NARRATED = [
  [{ text: 'Next: read the notebook.' }, { tool: 'datetime', args: {} }],
  [{ text: 'Next: count the entries.' }, { tool: 'datetime', args: {} }],
  [{ text: 'There are three entries in it.' }],
];

// A memory file of its own: the system prompt is read here, and it must be the one
// this test wrote, never the person's own.
const ownMemory = () => ({ memory: { file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-notes-')), 'memory.json') } });

async function narratedTurn(extra: Record<string, unknown> = {}): Promise<{ ui: Ui; model: ScriptedModel }> {
  const model = new ScriptedModel();
  model.script(...(NARRATED as never[]));
  const ui = await bootApp(model, 100, 28, undefined, { ...ownMemory(), ...extra });
  await ui.press('F');
  await ui.type('how many entries are there?');
  await ui.press('return');
  await settle(20);
  return { ui, model };
}

test('a turn that narrated twice leaves ONE step line, the last thing it said it was doing', async () => {
  const { ui } = await narratedTurn();
  // The second sentence came within the floor's second, so it waits it out.
  await settleUntil(() => ui.backend.lastFrame.includes('count the entries.'));
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('count the entries.');
  // One line, not two: the first step was replaced, not stacked.
  expect(frame).not.toContain('read the notebook.');
  // The `Next:` is the shape the prompt asks for, not something to read.
  expect(frame).not.toContain('Next:');
  // No fold header any more, and no prose block under it.
  expect(frame).not.toContain('▸ notes');
  expect(times(frame, 'count the entries.')).toBe(1);
  ui.app.unmount();
});

// This is the bug the prototype had: the line grew with the final answer as it
// streamed, because everything the model wrote fed it. Only the narration of rounds
// that carried tool calls does.
test('the answer\'s own text never reaches the step line', async () => {
  const { ui } = await narratedTurn();
  await settleUntil(() => ui.backend.lastFrame.includes('count the entries.'));
  const frame = ui.backend.lastFrame;
  // The answer is drawn once — as the answer, never again as the step.
  expect(times(frame, 'There are three entries in it.')).toBe(1);
  const step = frame.split('\n').find((r) => r.includes('count the entries.')) ?? '';
  expect(step).not.toContain('There are three');
  ui.app.unmount();
});

test('a turn that narrated nothing draws no line at all', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Three entries.' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('how many?');
  await ui.press('return');
  await settle(20);
  const frame = ui.backend.lastFrame;
  // A line drawn from the answer would put this sentence on screen twice.
  expect(times(frame, 'Three entries.')).toBe(1);
  expect(frame).not.toContain('▸ notes');
  ui.app.unmount();
});

test('narration that never finished a sentence leaves the line empty', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: 'Looking at the notebook' }, { tool: 'datetime', args: {} }],
    [{ text: 'Three entries.' }],
  );
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('how many?');
  await ui.press('return');
  await settle(20);
  // Half a sentence is never shown — the line keeps what it had, which here is nothing.
  expect(ui.backend.lastFrame).not.toContain('Looking at the notebook');
  ui.app.unmount();
});

test('^r still unfolds everything it said, and the rounds do not run together', async () => {
  const { ui } = await narratedTurn();
  await settleUntil(() => ui.backend.lastFrame.includes('count the entries.'));
  ui.backend.press({ name: 'r', ctrl: true });
  await settle(6);
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('▾ notes');
  expect(frame).toContain('Next: read the notebook.');
  expect(frame).toContain('Next: count the entries.');
  // Appended with nothing between them the two rounds read as one broken sentence.
  expect(frame).not.toContain('notebook.Next');
  ui.app.unmount();
});

test('a drag copies the answer, never the step line', async () => {
  const { ui } = await narratedTurn();
  await settleUntil(() => ui.backend.lastFrame.includes('count the entries.'));
  const lines = ui.backend.lastFrame.split('\n');
  const from = lines.findIndex((r) => r.includes('count the entries.'));
  const to = lines.findIndex((r) => r.includes('There are three entries in it.'));
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  ui.backend.mouse('down', 2, from);
  for (let y = from; y <= to; y++) ui.backend.mouse('drag', 90, y);
  ui.backend.mouse('up', 90, to);
  await settle(4);
  const [text] = ui.backend.clipboard;
  expect(text).toContain('There are three entries in it.');
  expect(text).not.toContain('count the entries.');
  ui.app.unmount();
});

// The mode decides how a round of narration is KEPT, and a round that has not ended
// is not yet narration: until it commits, the chat cannot tell what is arriving from
// the answer itself. So text on its way is drawn as it arrives, in every mode, and
// the mode applies the moment the round is in. (That is how the fold behaved too.)
test('a round still streaming is drawn as it arrives, whatever the mode; the mode applies when it commits', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: 'Next: read the notebook.' }, { hold: true }, { tool: 'datetime', args: {} }],
    [{ text: 'Three entries.' }],
  );
  const ui = await bootApp(model, 100, 24, undefined, { ...ownMemory(), plugins: { assistant: { notes: 'hidden' } } });
  await ui.press('F');
  await ui.type('how many?');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('Next: read the notebook.');
  model.release();
  await settle(20);
  // The round carried a tool call, so its text was narration after all — and `hidden`
  // keeps it off the screen from here on.
  const frame = ui.backend.lastFrame;
  expect(frame).not.toContain('read the notebook');
  expect(frame).toContain('Three entries.');
  ui.app.unmount();
});

test('/notes fold gives the older look, hidden draws nothing, open unfolds', async () => {
  const { ui } = await narratedTurn();
  await settleUntil(() => ui.backend.lastFrame.includes('count the entries.'));

  await ui.type('/notes fold');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('▸ notes');
  expect(ui.backend.lastFrame).toContain('Next: count the entries.');

  await ui.type('/notes hidden');
  await ui.press('return');
  await settle(6);
  let frame = ui.backend.lastFrame;
  expect(frame).not.toContain('▸ notes');
  expect(frame).not.toContain('count the entries.');
  // The answer and its quiet line are untouched by the narration's mode.
  expect(frame).toContain('There are three entries in it.');
  expect(frame).toMatch(/▸ 2 tools/);

  await ui.type('/notes open');
  await ui.press('return');
  await settle(6);
  frame = ui.backend.lastFrame;
  expect(frame).toContain('▾ notes');
  expect(frame).toContain('Next: read the notebook.');
  expect(frame).toContain('Next: count the entries.');

  await ui.type('/notes sideways');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('/notes takes step, fold, open or hidden');
  ui.app.unmount();
});

test('the config says where a conversation starts, and /clear brings the mode back there', async () => {
  const { ui, model } = await narratedTurn({ plugins: { assistant: { notes: 'fold' } } });
  // The config default applies from the first answer on.
  expect(ui.backend.lastFrame).toContain('▸ notes');

  await ui.type('/notes hidden');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).not.toContain('▸ notes');

  await ui.type('/clear');
  await ui.press('return');
  await settle(10);
  model.script(...(NARRATED as never[]));
  await ui.type('and now?');
  await ui.press('return');
  await settle(20);
  // Back to what the config asks for — the mode was this conversation's, and it is gone.
  expect(ui.backend.lastFrame).toContain('▸ notes');

  // /resume opens another conversation, and it brings its own answer with it.
  await ui.type('/notes step');
  await ui.press('return');
  await settle(6);
  expect(ui.backend.lastFrame).not.toContain('▸ notes');
  await ui.type('/resume 2');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('▸ notes');
  ui.app.unmount();
});

test('the model is asked for one Next: line before a call, and never told to say nothing', async () => {
  const { ui, model } = await narratedTurn();
  const sent = (model.requests[0]!.messages as { role: string; content?: string }[]).map((m) => String(m.content ?? '')).join('\n');
  expect(sent).toContain('Before you call a tool, write ONE short line that starts with "Next:" and says what you are about to do');
  expect(sent).toContain('Do not begin the final answer with "Next:"');
  // The clause it ignored is gone — a prompt that says both is a prompt that says
  // neither. (The live check of whether the instruction holds over a long turn, and
  // that it costs no tool call, is still owed.)
  expect(sent).not.toContain('think silently');
  ui.app.unmount();
});
