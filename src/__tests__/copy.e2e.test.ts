// Copying out of the app through the real chat: `/copy`, and a drag over the screen
// (flowtty's copy-on-select). The platform's clipboard tool is replaced — a test run
// must not overwrite the person's clipboard; everything before it is the real module.
// Bun's mock.module is process-wide, so a call that brings its own `exec` (the unit
// tests of copy.ts) still reaches the real function.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

const copied: string[] = [];
let toolWorks = true;
const real = await import('../assistant/copy.ts');
// Taken BEFORE the mock: `real` is a live namespace, so after mock.module its
// copyToClipboard IS the mock — calling it from the mock never returns.
const { copyTarget, copyToClipboard: realCopy } = real;
mock.module('../assistant/copy.ts', () => ({
  copyTarget,
  copyToClipboard: (text: string, platform?: string, exec?: Parameters<typeof realCopy>[2]) => {
    if (exec) return realCopy(text, platform, exec);
    if (!toolWorks) return { ok: false, error: 'no clipboard tool worked (tried pbcopy)' };
    copied.push(text);
    return { ok: true };
  },
}));
const { ScriptedModel, bootApp, settle } = await import('./helpers/scripted');
const { onCopySelection } = await import('../runtime/app.tsx');

const realFetch = globalThis.fetch;
beforeEach(() => { copied.length = 0; toolWorks = true; });
afterEach(() => { globalThis.fetch = realFetch; });

type Ui = Awaited<ReturnType<typeof bootApp>>;

// Where `needle` is drawn: its first cell. The grid is one cell per code point.
function cellOf(ui: Ui, needle: string): { x: number; y: number } {
  const lines = ui.backend.lastFrame.split('\n');
  for (let y = 0; y < lines.length; y++) {
    const at = lines[y]!.indexOf(needle);
    if (at >= 0) return { x: Array.from(lines[y]!.slice(0, at)).length, y };
  }
  throw new Error(`"${needle}" is not on screen:\n${ui.backend.lastFrame}`);
}

// A press, one drag step per cell crossed on the way, a release — as a terminal
// reports a drag.
async function drag(ui: Ui, from: { x: number; y: number }, to: { x: number; y: number }) {
  ui.backend.mouse('down', from.x, from.y);
  for (let y = from.y; y <= to.y; y++) ui.backend.mouse('drag', y === to.y ? to.x : from.x, y);
  ui.backend.mouse('up', to.x, to.y);
  await settle(4);
}

const PARA = 'The quick brown fox jumps over the lazy dog and keeps running across the wide green field until the sun goes down behind the distant hills far away.';
async function chatWithAnswer() {
  const model = new ScriptedModel();
  model.script([{ text: `First line.\n\n${PARA}\n\n\`\`\`sh\nbun test\n\`\`\`\n` }]);
  const ui = await bootApp(model, 80, 28);
  await ui.press('F');
  await ui.type('hello');
  await ui.press('return');
  await settle(20);
  // The paragraph is wider than the chat: it wraps, so the copy has rows to rejoin.
  expect(ui.backend.lastFrame).toContain('hills far away.');
  expect(ui.backend.lastFrame).not.toContain(PARA);
  return { ui, model };
}

test('/copy puts the last code block on the clipboard and says so; nothing goes to the model', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Проверить локально:\n\n```sh\nbun test src/features/routes\n```\n' }]);
  const ui = await bootApp(model, 100, 28);
  ui.backend.clipboardAvailable = false;
  await ui.press('F');
  await ui.type('как проверить локально?');
  await ui.press('return');
  await settle(20);

  await ui.type('/copy');
  await ui.press('return');
  await settle(4);
  // No clipboard sequence could go out, so the platform's tool took it.
  expect(copied).toEqual(['bun test src/features/routes']);
  expect(ui.backend.lastFrame).toContain('Copied the sh code block');
  expect(model.requests).toHaveLength(1);
  ui.app.unmount();
});

test('/copy goes through the terminal where it can — no platform tool, and one toast', async () => {
  const model = new ScriptedModel();
  model.script([{ text: '```sh\nbun test\n```\n' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('how?');
  await ui.press('return');
  await settle(20);
  await ui.type('/copy');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.clipboard).toEqual(['bun test']);
  expect(copied).toEqual([]);
  // The api copy fires onCopy as well; only /copy's own message is shown.
  expect(ui.backend.lastFrame).toContain('Copied the sh code block');
  expect(ui.backend.lastFrame).not.toContain('Copied 8 chars');
  ui.app.unmount();
});

test('a drag across an answer copies its text only — no marker, no border, no field — and a wrapped paragraph as one line', async () => {
  const { ui } = await chatWithAnswer();
  const start = cellOf(ui, 'ƒ First line.');
  const end = cellOf(ui, '│ bun test');
  // From the marker to past the chat's right edge: the scope stops it at the pane.
  await drag(ui, start, { x: 79, y: end.y });
  const text = 'First line.\n\n' + PARA + '\n\nbun test';
  expect(ui.backend.clipboard).toEqual([text]);
  expect(copied).toEqual([]);
  expect(ui.backend.lastFrame).toContain(`Copied ${Array.from(text).length} chars`);
  ui.app.unmount();
});

test('a wrapped heading copies as one line, without the ▍ marker', async () => {
  const model = new ScriptedModel();
  const heading = 'A heading long enough to wrap inside the chat window at this width of the terminal';
  model.script([{ text: `## ${heading}\n\nBody.\n` }]);
  const ui = await bootApp(model, 80, 28);
  await ui.press('F');
  await ui.type('hi');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).not.toContain(heading);
  const start = cellOf(ui, '▍ A heading');
  const end = cellOf(ui, 'Body.');
  await drag(ui, start, { x: end.x + 4, y: end.y });
  expect(ui.backend.clipboard).toEqual([`${heading}\n\nBody.`]);
  ui.app.unmount();
});

// The person's message is drawn as typed: a line break they typed copies as a line
// break, and a line the chat had to wrap copies as the one line it was.
test('a drag over the person\'s message copies it as typed — its line breaks kept, a wrapped line whole', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Ok.' }]);
  const ui = await bootApp(model, 60, 28);
  await ui.press('F');
  const long = 'this line is typed long enough that the chat has to wrap it twice over, at least';
  for (const [i, line] of ['line one', 'line two', long].entries()) {
    if (i) ui.backend.press({ name: 'return', meta: true });
    await ui.type(line);
  }
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).not.toContain(long);
  const start = cellOf(ui, 'line one');
  const end = cellOf(ui, 'at least');
  await drag(ui, start, { x: end.x + 'at least'.length, y: end.y });
  expect(ui.backend.clipboard).toEqual([`line one\nline two\n${long}`]);
  ui.app.unmount();
});

test('a drag that runs past the conversation stays in it: nothing of the hint line or the field', async () => {
  const { ui } = await chatWithAnswer();
  const start = cellOf(ui, 'hills far away.');
  const field = cellOf(ui, 'send');
  await drag(ui, start, { x: 79, y: field.y + 3 });
  const [text] = ui.backend.clipboard;
  expect(text).toStartWith('hills far away.');
  expect(text).toContain('bun test');
  for (const chrome of ['│', 'ƒ', '›', 'history', 'send', 'commands', 'ctx']) expect(text).not.toContain(chrome);
  ui.app.unmount();
});

// The command line. Everything on its row but the command itself is the host
// speaking — the `: ` prompt, the inline offer after the caret, the `⇥ a · b`
// candidates — and so is the footer that takes the row when the line is closed.
test('a drag over the command line copies the command as typed — no prompt, no offer, no candidates', async () => {
  const ui = await bootApp(new ScriptedModel(), 80, 20);
  await ui.press(':');
  const typed = 'config set plugins.mcp.servers.safari.readOnly';
  await ui.type(typed);
  const at = cellOf(ui, typed);
  // From the prompt, past the right edge and on down: the footer is a scope of its
  // own, so the drag stays on the row it started on.
  await drag(ui, { x: 0, y: at.y }, { x: 79, y: at.y + 1 });
  expect(ui.backend.clipboard).toEqual([typed]);
  ui.app.unmount();
});

test('a drag over a half-typed command copies what was typed, not what is offered', async () => {
  const ui = await bootApp(new ScriptedModel(), 80, 20);
  await ui.press(':');
  await ui.type('c');
  // `cache` is offered after the caret and the rest of the commands beside it.
  expect(ui.backend.lastFrame).toContain(': cache');
  expect(ui.backend.lastFrame).toContain('clear-cache');
  const at = cellOf(ui, ': cache');
  await drag(ui, { x: at.x, y: at.y }, { x: 79, y: at.y });
  expect(ui.backend.clipboard).toEqual(['c']);
  ui.app.unmount();
});

test('a drag over the hint row picks up nothing: the footer is chrome', async () => {
  const ui = await bootApp(new ScriptedModel(), 80, 20);
  const at = cellOf(ui, ': commands');
  await drag(ui, { x: 0, y: at.y }, { x: 79, y: at.y });
  expect(ui.backend.clipboard).toEqual([]);
  ui.app.unmount();
});

test('no clipboard sequence (Apple Terminal) → the platform tool takes the text, and the toast says so', async () => {
  const { ui } = await chatWithAnswer();
  ui.backend.clipboardAvailable = false;
  const start = cellOf(ui, 'First line.');
  await drag(ui, start, { x: start.x + 10, y: start.y });
  expect(ui.backend.clipboard).toEqual([]);
  expect(copied).toEqual(['First line.']);
  expect(ui.backend.lastFrame).toContain('Copied 11 chars');
  ui.app.unmount();
});

test('no sequence and no tool either → the toast says the copy failed', async () => {
  const { ui } = await chatWithAnswer();
  ui.backend.clipboardAvailable = false;
  toolWorks = false;
  const start = cellOf(ui, 'First line.');
  await drag(ui, start, { x: start.x + 10, y: start.y });
  expect(ui.backend.lastFrame).toContain('Copy failed — no clipboard tool worked');
  ui.app.unmount();
});

test('onCopy never throws, even when the fallback does, and leaves an api copy to its caller', () => {
  const said: string[] = [];
  const say = (m: string) => { said.push(m); };
  const boom = () => { throw new Error('spawn EACCES'); };
  expect(() => onCopySelection({ text: 'x', delivered: false, source: 'selection' }, { say, fallback: boom })).not.toThrow();
  expect(said).toEqual(['Copy failed — spawn EACCES']);
  let calls = 0;
  onCopySelection({ text: 'x', delivered: false, source: 'api' }, { say, fallback: () => { calls++; return { ok: true }; } });
  expect(calls).toBe(0);
  expect(said).toHaveLength(1);
});

// ─── mouse keys are not keys ──────────────────────────────────────────────────
// A press, a drag and a release reach every `useInput` subscriber. None of the
// host's handlers may read one as a character, as "any key" or as a dismissal.
async function click(ui: Ui, at: { x: number; y: number }) {
  ui.backend.mouse('down', at.x, at.y);
  ui.backend.mouse('drag', at.x + 3, at.y);
  ui.backend.mouse('up', at.x + 3, at.y);
  ui.backend.mouse('down', at.x, at.y);
  ui.backend.mouse('up', at.x, at.y);
  await settle(4);
}

test('a click or a drag types nothing into the chat field and does not disarm Esc Esc', async () => {
  const { ui } = await chatWithAnswer();
  await ui.type('draft');
  await click(ui, cellOf(ui, 'draft'));
  await click(ui, cellOf(ui, 'First line.'));
  expect(ui.backend.lastFrame).toContain('› draft');
  expect(ui.backend.lastFrame).not.toMatch(/draft\S/);
  await ui.press('escape'); // clears the field
  await ui.press('escape'); // arms the exit
  expect(ui.backend.lastFrame).toContain('Esc again to exit');
  await click(ui, cellOf(ui, 'First line.'));
  expect(ui.backend.lastFrame).toContain('Esc again to exit');
  ui.app.unmount();
});

test('a click does not answer a y/n write confirmation', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'echo hi' } }], [{ text: 'Declined, fine.' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('run it');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Confirm write: run_command');
  await click(ui, cellOf(ui, 'Press y to confirm'));
  await click(ui, cellOf(ui, 'run it'));
  expect(ui.backend.lastFrame).toContain('Confirm write: run_command');
  expect(model.requests).toHaveLength(1);
  await ui.press('n');
  await settle(10);
  expect(ui.backend.lastFrame).not.toContain('Confirm write');
  ui.app.unmount();
});

test('a click does not answer or dismiss an ask_user question', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_user', args: { questions: [{ question: 'Rebase or merge?', options: [{ label: 'rebase' }, { label: 'merge' }] }] } }],
    [{ text: 'OK.' }],
  );
  const ui = await bootApp(model, 100, 30);
  await ui.press('F');
  await ui.type('which?');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Rebase or merge?');
  await click(ui, cellOf(ui, 'merge'));
  await click(ui, cellOf(ui, 'which?'));
  expect(ui.backend.lastFrame).toContain('Rebase or merge?');
  expect(model.requests).toHaveLength(1);
  await ui.press('escape');
  await settle(10);
  expect(ui.backend.lastFrame).not.toContain('Rebase or merge?');
  ui.app.unmount();
});

// The windows set their own ink (`color: m.text`), so every glyph under a drag has an
// explicit colour — and a selection that painted the band in the terminal's default
// foreground with that ink on it drew dark on dark on a light terminal. Held mid-drag:
// what is on screen while the person is still selecting.
test('text being selected stays readable on a light terminal', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Readable when selected.' }]);
  const ui = await bootApp(model, 80, 28, undefined, {}, { scheme: 'light' });
  await ui.press('F');
  await ui.type('hello');
  await ui.press('return');
  await settle(20);
  const from = cellOf(ui, 'Readable');
  ui.backend.mouse('down', from.x, from.y);
  ui.backend.mouse('drag', from.x + 8, from.y);
  await settle(4);
  const cell = (ui.backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { fg?: string; bg?: string; inverse?: boolean } } } }).lastBuffer.get(from.x + 2, from.y);
  expect(cell.style.inverse).toBe(true);
  // A band and a glyph of two different colours, both named — not one of them left to
  // the terminal's foreground, which is the colour the other one already has.
  expect(cell.style.fg).toBeDefined();
  expect(cell.style.bg).toBeDefined();
  expect(cell.style.fg).not.toBe(cell.style.bg);
  ui.backend.mouse('up', from.x + 8, from.y);
  ui.app.unmount();
});

test('a click does not dismiss the reminder banner or close the log', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'remind', args: { in: '0.1 seconds', text: 'blink' } }], [{ text: 'Will do.' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('remind me');
  await ui.press('return');
  await settle(20);
  await new Promise((r) => setTimeout(r, 200));
  await settle(4);
  expect(ui.backend.lastFrame).toContain('— dismiss');
  await click(ui, cellOf(ui, 'blink'));
  await click(ui, { x: 1, y: 1 });
  expect(ui.backend.lastFrame).toContain('— dismiss');
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toContain('— dismiss');
  // The log: opened by its key, closed by its key or Esc — never by a click.
  await ui.press('escape', 'escape');
  await ui.press('L');
  expect(ui.backend.lastFrame).toMatch(/Log/);
  await click(ui, { x: 1, y: 1 });
  await click(ui, cellOf(ui, 'Esc close'));
  expect(ui.backend.lastFrame).toContain('Esc close');
  ui.app.unmount();
});
