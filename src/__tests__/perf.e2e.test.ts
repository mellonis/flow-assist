// `:perf` and the frame meter in the running app: each key is counted once, whichever
// pass of the host's key path handles it, the frames are tagged by the input that led
// to them, and the report lands in the log.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { createFrameMeter } from '../runtime/frame-stats';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const lastRow = (ui: { backend: { lastFrame: string } }) => ui.backend.lastFrame.split('\n').filter((r) => r.trim()).at(-1) ?? '';

test('typing on the `:` line is typing frames, one input each, timed from the key', async () => {
  const meter = createFrameMeter();
  const ui = await bootApp(new ScriptedModel(), 100, 24, undefined, {}, { frameMeter: meter });
  // `:` types a character too; Esc is another key.
  await ui.press(':');
  await ui.press('escape');
  expect(meter.frames('other').at(-1)).toMatchObject({ kind: 'other', inputs: 1 });
  await ui.press(':');
  // One key at a time: each is its own frame. The `:` line hears a key in the host's
  // second pass — the meter still counts it once.
  for (const ch of 'pe') await ui.type(ch);
  const typed = meter.frames('typing');
  expect(typed).toHaveLength(4);
  for (const f of typed) {
    expect(f.inputs).toBe(1);
    expect(f.commits).toBeGreaterThanOrEqual(1);
    expect(f.latencyMs).toBeGreaterThanOrEqual(f.workMs);
  }
  // Keys in one read share the frame after them.
  await ui.type('rf');
  expect(meter.frames('typing').at(-1)).toMatchObject({ inputs: 2 });
  ui.app.unmount();
});

test(':perf writes the report to the log and says its gist', async () => {
  const ui = await bootApp(new ScriptedModel(), 120, 30);
  await ui.press(':');
  await ui.type('perf');
  await ui.press('return');
  expect(lastRow(ui)).toContain('perf: ');
  expect(lastRow(ui)).toContain('typing p95');
  expect(lastRow(ui)).toContain('the report is in the log');
  await ui.press('L');
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('[perf] the last 200 frames of each kind');
  expect(frame).toContain('[perf] typing: ');
  expect(frame).toContain('[perf] wheel: no frames');
  ui.app.unmount();
});

// The chat's list keeps its rows, its renderer and its callbacks the same objects while
// the conversation does not change, so a key typed into the field below it re-renders
// none of the rows in view: a keystroke costs the same with one row on the screen as
// with a screenful.
test('typing in the chat field draws no conversation row again', async () => {
  const meter = createFrameMeter();
  const model = new ScriptedModel();
  const ui = await bootApp(model, 100, 30, undefined, {}, { frameMeter: meter });
  await ui.press('F');
  const keystroke = async () => {
    await ui.type('x');
    const f = meter.frames('typing').at(-1)!;
    await ui.press('backspace');
    return f;
  };
  model.script([{ text: 'short' }]);
  await ui.type('first');
  await ui.press('return');
  await settle(20);
  const few = await keystroke();
  for (let t = 0; t < 3; t++) {
    model.script([{ text: Array.from({ length: 30 }, (_x, i) => `- line ${i} of answer ${t}`).join('\n') }]);
    await ui.type(`question ${t}`);
    await ui.press('return');
    await settle(20);
  }
  expect(ui.backend.lastFrame).toContain('line 14 of answer 2');
  const many = await keystroke();
  expect(many.commits).toBe(1);
  expect(many.applied).toBeLessThanOrEqual(1);
  expect(many.skipped).toBe(few.skipped);
  ui.app.unmount();
});
