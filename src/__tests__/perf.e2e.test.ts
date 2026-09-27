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
