// The person's own message is drawn as it was typed. It used to be laid out as
// markdown, where a single line break is a soft one: two lines became one, an
// indented command lost its indent, and `- a` turned into a bullet.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Ui = Awaited<ReturnType<typeof bootApp>>;

// Types `lines` into the field with Alt+⏎ between them, and sends.
async function sendLines(ui: Ui, lines: string[]) {
  for (let i = 0; i < lines.length; i++) {
    if (i) ui.backend.press({ name: 'return', meta: true });
    await ui.type(lines[i]!);
  }
  await ui.press('return');
  await settle(20);
}

// The frame's rows from the one holding `needle` on, `n` of them.
function rowsFrom(ui: Ui, needle: string, n: number): string[] {
  const rows = ui.backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes(needle));
  if (y < 0) throw new Error(`"${needle}" is not on screen:\n${ui.backend.lastFrame}`);
  return rows.slice(y, y + n);
}

test('two typed lines are two rows under the › marker, not one joined line', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Got both.' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await sendLines(ui, ['line one', 'line two']);
  expect(ui.backend.lastFrame).toContain('Got both.');
  expect(ui.backend.lastFrame).not.toContain('line one line two');
  const [first, second] = rowsFrom(ui, '› line one', 2);
  // The second line sits in the gutter's column under the first, without a marker.
  expect(second!.indexOf('line two')).toBe(first!.indexOf('line one'));
  expect(second).not.toContain('›');
  // The model was always sent the text as typed.
  const sent = model.requests[0]!.messages as { role: string; content?: string }[];
  expect(sent.at(-1)!.content).toBe('line one\nline two');
  ui.app.unmount();
});

test('leading spaces and blank lines are kept, and nothing is read as markdown', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Ok.' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await sendLines(ui, ['run', '  npm test', '', 'do this:', '- a', '**b**']);
  const [run, npm, blank, doThis, a, b] = rowsFrom(ui, '› run', 6);
  const col = run!.indexOf('run');
  expect(npm!.indexOf('npm test')).toBe(col + 2);
  expect(blank!.slice(col, blank!.lastIndexOf('│')).trim()).toBe('');
  expect(doThis!.indexOf('do this:')).toBe(col);
  expect(a!.indexOf('- a')).toBe(col);
  expect(b!.indexOf('**b**')).toBe(col);
  expect(ui.backend.lastFrame).not.toContain('• a');
  ui.app.unmount();
});

test('a line wider than the chat wraps onto rows of its own, each one terminal line', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Ok.' }]);
  const ui = await bootApp(model, 60, 28);
  await ui.press('F');
  const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
  await sendLines(ui, [long, 'after']);
  const frame = ui.backend.lastFrame;
  expect(frame).not.toContain(long);
  // Every character of the line is on screen, in order, across the wrapped rows.
  const start = frame.split('\n').findIndex((r) => r.includes('› w0 '));
  const end = frame.split('\n').findIndex((r, i) => i > start && r.includes('after'));
  expect(end - start).toBeGreaterThan(1);
  const rows = frame.split('\n').slice(start, end);
  const col = rows[0]!.indexOf('w0');
  const text = rows.map((r) => r.slice(col, r.lastIndexOf('│'))).join('');
  expect(text.replace(/\s/g, '')).toBe(long.replace(/\s/g, ''));
  // Nothing runs out of the window: every row still ends at the frame.
  for (const r of rows) expect(r.trimEnd().endsWith('│')).toBe(true);
  ui.app.unmount();
});
