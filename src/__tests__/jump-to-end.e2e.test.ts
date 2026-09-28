// Back to the end of the conversation: away from it — scrolled up, or a long answer
// resting at its first line — a `↓` sits at the conversation's bottom-right corner,
// `↓ new` once something arrived since; a click on it or End brings the list to the
// end, and there it is gone.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const LONG = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the answer`).join('\n\n');
type Ui = Awaited<ReturnType<typeof bootApp>>;

// The control's label and where it is, from the frame: the conversation's rows are the
// ones above the hint row (the status line while a turn runs).
function control(ui: Ui): { label: string; x: number; y: number } | null {
  const rows = ui.backend.lastFrame.split('\n');
  const hint = rows.findIndex((r) => /history · wheel|Esc stops/.test(r));
  for (let y = 0; y < hint; y++) {
    const m = /(↓ new|↓) +│\s*$/.exec(rows[y]!);
    if (m) return { label: m[1]!, x: Array.from(rows[y]!.slice(0, m.index)).length, y };
  }
  return null;
}
const atEnd = (ui: Ui) => ui.backend.lastFrame.includes('line 40 of the answer');

async function longAnswer(model: ScriptedModel): Promise<Ui> {
  const ui = await bootApp(model, 100, 24);
  await ui.press('F');
  await ui.type('long please');
  await ui.press('return');
  await settle(20);
  return ui;
}

test('away from the end the control is drawn; a click on it goes to the end, and it is gone', async () => {
  const model = new ScriptedModel();
  model.script([{ text: LONG }]);
  const ui = await longAnswer(model);
  // The long answer rests at its first line: the end is below.
  expect(atEnd(ui)).toBe(false);
  const c = control(ui)!;
  expect(c.label).toBe('↓');
  ui.backend.mouse('down', c.x, c.y);
  ui.backend.mouse('up', c.x, c.y);
  await settle(6);
  expect(atEnd(ui)).toBe(true);
  expect(control(ui)).toBeNull();
  // Scrolled up by hand, it is back.
  for (let i = 0; i < 4; i++) ui.backend.wheel('up', 20, 8);
  await settle(6);
  expect(atEnd(ui)).toBe(false);
  expect(control(ui)?.label).toBe('↓');
  ui.app.unmount();
});

test('End goes to the end from an empty field; in a draft it is the field’s own key first', async () => {
  const model = new ScriptedModel();
  model.script([{ text: LONG }]);
  const ui = await longAnswer(model);
  expect(control(ui)).not.toBeNull();
  await ui.press('end');
  expect(atEnd(ui)).toBe(true);
  expect(control(ui)).toBeNull();

  for (let i = 0; i < 4; i++) ui.backend.wheel('up', 20, 8);
  await settle(6);
  // A draft with the caret inside it: End takes the caret to the line's end, and the
  // conversation stays where it was…
  await ui.type('draft');
  await ui.press('left', 'left');
  await ui.press('end');
  expect(atEnd(ui)).toBe(false);
  // …and with the caret at the end already, End jumps.
  await ui.press('end');
  expect(atEnd(ui)).toBe(true);
  expect(ui.backend.lastFrame).toContain('› draft');
  ui.app.unmount();
});

test('in a draft of several lines, End with a later line after the caret stays the field’s', async () => {
  const model = new ScriptedModel();
  model.script([{ text: LONG }]);
  const ui = await longAnswer(model);
  await ui.type('abc');
  ui.backend.press({ name: 'return', meta: true }); // a new line
  await ui.type('def');
  await ui.press('up'); // the caret at the end of `abc`, `def` still after it
  for (let i = 0; i < 4; i++) ui.backend.wheel('up', 20, 8);
  await settle(6);
  expect(control(ui)).not.toBeNull();
  await ui.press('end');
  expect(atEnd(ui)).toBe(false);
  expect(control(ui)).not.toBeNull();
  // At the very end of the draft, End jumps.
  await ui.press('down');
  await ui.press('end');
  expect(atEnd(ui)).toBe(true);
  expect(ui.backend.lastFrame).toContain('def');
  ui.app.unmount();
});

test('the control says `↓ new` once something arrives while the list is away from the end', async () => {
  const model = new ScriptedModel();
  model.script([{ text: LONG }], [{ text: 'Second start.' }, { hold: true }, { text: ' And more.' }]);
  const ui = await longAnswer(model);
  await ui.type('and now?');
  await ui.press('return');
  await settle(20);
  expect(control(ui)).toBeNull();
  for (let i = 0; i < 4; i++) ui.backend.wheel('up', 20, 8);
  await settle(6);
  expect(control(ui)?.label).toBe('↓');
  model.release();
  await settle(20);
  expect(control(ui)?.label).toBe('↓ new');
  await ui.press('end');
  expect(control(ui)).toBeNull();
  expect(ui.backend.lastFrame).toContain('And more.');
  ui.app.unmount();
});

test('the key is remappable: `keys.toEnd` moves it', async () => {
  const model = new ScriptedModel();
  model.script([{ text: LONG }]);
  const ui = await bootApp(model, 100, 24, undefined, { keys: { toEnd: 'ctrl+e' } });
  await ui.press('F');
  await ui.type('long please');
  await ui.press('return');
  await settle(20);
  expect(control(ui)).not.toBeNull();
  ui.backend.press({ name: 'e', ctrl: true });
  await settle(6);
  expect(atEnd(ui)).toBe(true);
  ui.app.unmount();
});
