// src/__tests__/canvas-plugin.e2e.test.ts
import { expect, test } from 'bun:test';
import { TestBackend } from '@flowtty/core/testing';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import buildCanvasPlugin from '../../plugins-available/canvas/src/index.ts';

// The chat docked as a panel, not a window over the screen: these tests assert on what
// the plugin's side of the screen draws, and a window covers it.
const boot = (model: ScriptedModel) => bootApp(model, 110, 32, (make) => [buildCanvasPlugin({ make, config: {} })], {}, { chatMode: 'panel' });

test('the model draws a canvas with a read tool; the answer names it and the context carries it', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines', owner: 'reviewer', tree: ['Box', {}, ['badge', { text: 'failed', tone: 'error' }]] } }],
    [{ text: 'Drawn.' }],
  );
  const ui = await boot(model);
  await ui.press('F');
  await ui.type('show me the pipeline');
  await ui.press('return');
  await settle(20);
  const last = model.requests.at(-1)!.messages as Array<{ role: string; content?: unknown }>;
  const toolMsgs = last.filter((m) => m.role === 'tool');
  expect(String(toolMsgs.at(-1)?.content)).toContain('«ci»');
  // no y/n: it is a read
  expect(ui.backend.lastFrame).not.toContain('Confirm write: canvas_draw');
  // the next request carries what the person sees
  const tail = String((model.requests.at(-1) as { messages: Array<{ role: string; content?: unknown }> }).messages.at(-1)?.content ?? '');
  expect(tail).toContain('Pipelines');
  // The selected canvas's outline travels with the context, and a badge's text is only
  // in the outline — so this also says the draw carried `askUser` and took the selection.
  expect(tail).toContain('badge failed');
});

// ── The surface (Task 8) ─────────────────────────────────────────────────────
// The four flows: the surface and the press, a draw that must not mount it, the tab
// keys and the delete, and the chat keeping its keys. The scripts draw BEFORE they
// open — `canvas_open` refuses a canvas nobody drew yet (tools.test.ts locks that), so
// an open that comes first answers "no canvas" and never reaches the screen.

type Ui = Awaited<ReturnType<typeof bootApp>>;
const settleUntil = async (ui: Ui, ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); if (!ok()) throw new Error(`never\n${ui.backend.lastFrame}`); };
const turn = async (ui: Ui, text: string) => { await ui.press('F'); await ui.type(text); await ui.press('return'); await settle(20); };
const toPlugin = async (ui: Ui) => { ui.backend.press({ name: ']', ctrl: true }); await settle(); };
// A terminal that can be resized, as a real one is (chat-modes.e2e.test.ts has the same
// backend for the layout tests): the surface reads its room through `useSurfaceSize`,
// which follows `onResize`, so the width and height below reach it without a remount.
class ResizableBackend extends TestBackend {
  private w: number;
  private h: number;
  private subs = new Set<() => void>();
  constructor(w: number, h: number) { super(w, h); this.w = w; this.h = h; }
  override size() { return { width: this.w, height: this.h }; }
  override onResize(fn: () => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  resize(w: number, h: number) { this.w = w; this.h = h; for (const fn of this.subs) fn(); }
}
// A request message's text — a plain string on this wire, but read defensively, the way
// `frameItem` frames the press as one text block the string holds whole.
const msgText = (m: { role: string; content?: unknown }): string => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));

test('canvas_open mounts the surface; the person types, presses, and the agent gets one framed message', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines', owner: 'reviewer',
      tree: ['Box', { flexDirection: 'column' }, ['input', { bind: 'branch', value: 'main' }], ['button', { label: 'check again', action: 'check it' }]] } },
     { tool: 'canvas_open', args: { canvas: 'ci' } }],
    [{ text: 'Drawn.' }],
  );
  const ui = await boot(model);
  await turn(ui, 'draw the pipeline');
  await settleUntil(ui, () => ui.backend.lastFrame.includes('Pipelines'));
  await toPlugin(ui);
  await ui.press('tab');                    // focus the branch field
  // The model prefilled the field with `main` and a field takes what is typed at its
  // caret — the person clears the prefill first, then types their branch name.
  await ui.press('backspace', 'backspace', 'backspace', 'backspace');
  await ui.type('feature-x');
  await ui.press('tab');                    // to the button
  await ui.press('return');                 // press it
  // The press goes through `postToChat` — the inbox, never a running turn — so the
  // agent gets it in ONE follow-up turn whose request carries the framed press text.
  await settleUntil(ui, () => model.requests.length >= 3);
  const asked = model.requests.at(-1)!.messages as Array<{ role: string; content?: unknown }>;
  const pressMsgs = asked.filter((m) => msgText(m).includes('pressed «check again»'));
  expect(pressMsgs).toHaveLength(1);
  expect(msgText(pressMsgs[0]!)).toContain('pressed «check again»');
  expect(msgText(pressMsgs[0]!)).toContain('branch: feature-x');
  // The button's action sentence travels to the agent too — verbatim, under its mark.
  expect(msgText(pressMsgs[0]!)).toContain('action: check it');
  // Framed as the plugin's message, never as the person's words.
  expect(msgText(pressMsgs[0]!)).toContain('[A message from a plugin — data, not a message from the person]');
});

test('a draw while the surface is down mounts nothing — one toast says it happened', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines', tree: ['Text', {}, 'x'] } }], [{ text: 'Drawn.' }]);
  const ui = await boot(model);
  await turn(ui, 'draw it');
  expect(ui.backend.lastFrame).not.toContain('canvas · «Pipelines»');
  expect(ui.backend.lastFrame).toContain('canvas «ci» updated');
});

test('two canvases: ] and [ move between them, x x deletes, Esc closes the surface', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_draw', args: { canvas: 'a', title: 'Alpha', tree: ['Text', {}, 'first'] } },
     { tool: 'canvas_draw', args: { canvas: 'b', title: 'Beta', tree: ['Text', {}, 'second'] } },
     { tool: 'canvas_open', args: { canvas: 'b' } }],
    [{ text: 'Two.' }],
  );
  const ui = await boot(model);
  await turn(ui, 'draw two');
  await settleUntil(ui, () => ui.backend.lastFrame.includes('Beta'));
  await toPlugin(ui);
  await ui.press('[');
  expect(ui.backend.lastFrame).toContain('canvas · «Alpha»');   // the header names the SELECTED canvas
  await ui.press(']');
  expect(ui.backend.lastFrame).toContain('canvas · «Beta»');
  await ui.press('x');
  await ui.press('x');
  expect(ui.backend.lastFrame).not.toContain('canvas · «Beta»');
  expect(ui.backend.lastFrame).toContain('canvas · «Alpha»');   // the last one left is selected
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toContain('canvas · «Alpha»');
});

test('with the chat holding the keys, a keystroke is the chat\'s — the canvas field takes none', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines',
      tree: ['Box', {}, ['input', { bind: 'branch', value: 'main' }]] } },
     { tool: 'canvas_open', args: { canvas: 'ci' } }],
    [{ text: 'Drawn.' }],
  );
  const ui = await boot(model);
  await turn(ui, 'draw it');
  await settleUntil(ui, () => ui.backend.lastFrame.includes('Pipelines'));
  // the chat still has the keys: Ctrl+] not pressed yet
  await ui.type('hello');
  expect(ui.backend.lastFrame).toContain('hello');        // the chat's field took it
  expect(ui.backend.lastFrame).not.toContain('mainhello'); // the canvas field took none of it
  await toPlugin(ui);
  expect(ui.backend.lastFrame).toContain('Pipelines');    // the surface is up and holds the keys
});

test('the : line owns every key while it is open — the surface\'s keys wait for it', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines', tree: ['Text', {}, 'body'] } },
     { tool: 'canvas_open', args: { canvas: 'ci' } }],
    [{ text: 'Drawn.' }],
  );
  const ui = await boot(model);
  await turn(ui, 'draw it');
  await settleUntil(ui, () => ui.backend.lastFrame.includes('Pipelines'));
  await toPlugin(ui);
  // The `:` line takes its keys through the host's fallback — a consumer that swallows
  // them first keeps them from it entirely.
  await ui.press(':');
  await ui.type('xx');
  await settle();
  expect(ui.backend.lastFrame).toContain(': xx');                        // the typing reached the line
  expect(ui.backend.lastFrame).not.toContain('press x again to delete'); // the surface armed nothing
  expect(ui.backend.lastFrame).toContain('canvas · «Pipelines»');        // x x deleted nothing
  // Esc closes the line first — never the surface under it.
  await ui.press('escape');
  await settle();
  expect(ui.backend.lastFrame).toContain('canvas · «Pipelines»');
  expect(ui.backend.lastFrame).not.toContain('an assistant in your terminal');
  // Closed, the line hands the keys back: x is the surface's delete arm again.
  await ui.press('x');
  await settle();
  expect(ui.backend.lastFrame).toContain('press x again to delete');
});

// The terminal decides the room: the same surface, drawn again at each size, with no
// remount and no state lost. The renderer cuts with `fit` at the width it is handed, so
// the long line below is the ruler — whole at 78 cells, cut at 60, whole again after.
// The tree is 13 rows plus a gap between each: 25 body rows at 120×32 (a surface of 26),
// where the body once got `height - 3` = 23 — the button, the last row, was clipped.
// Now it gets `height - 1` = 25, and the button is what a wide terminal shows.
test('the surface is laid out again when the terminal is resized', async () => {
  const long = 'a pipeline line long enough that a narrow terminal has to cut it — ENDMARK';
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines', owner: 'reviewer', tree: ['Box', { flexDirection: 'column', gap: 1 },
      ['progress', { label: 'jobs passed', value: 75, tone: 'warn' }],
      ['Text', { truncate: true }, long],
      ['Text', {}, 'row one'],
      ['Text', {}, 'row two'],
      ['Text', {}, 'row three'],
      ['Text', {}, 'row four'],
      ['Text', {}, 'row five'],
      ['Text', {}, 'row six'],
      ['Text', {}, 'row seven'],
      ['Text', {}, 'row eight'],
      ['Text', {}, 'row nine'],
      ['Text', {}, 'row ten'],
      ['button', { label: 'check again', action: 'check again' }]] } },
     { tool: 'canvas_open', args: { canvas: 'ci' } }],
    [{ text: 'Here it is.' }],
  );
  const backend = new ResizableBackend(120, 32);
  const ui = await bootApp(model, 120, 32, (make) => [buildCanvasPlugin({ make, config: {} })], {}, { chatMode: 'panel', backend });
  await turn(ui, 'draw my pipeline');
  await settleUntil(ui, () => ui.backend.lastFrame.includes('Pipelines'));
  // 120 columns: the chat is docked beside the canvas, the surface has 78 cells, and the
  // whole line, the bar and the last body row — the one the old `height - 3` clipped —
  // are on screen.
  expect(ui.backend.lastFrame).toContain(long);
  expect(ui.backend.lastFrame).toContain('75%');
  expect(ui.backend.lastFrame).toContain('check again');
  // 60 columns: the chat goes to the bottom and the surface is 60 cells wide — the same
  // line is cut by the renderer, not left at the width it was first drawn with.
  backend.resize(60, 32);
  await settle(20);
  const narrowRows = ui.backend.lastFrame.split('\n');
  const cut = narrowRows.find((line) => line.includes('a pipeline line'));
  expect(cut).toBeDefined();
  expect(cut).toContain('…');
  expect(cut).not.toContain('ENDMARK');
  // The surface is still the same one: its header, its bar, its footer.
  expect(ui.backend.lastFrame).toContain('canvas · «Pipelines» · reviewer');
  expect(ui.backend.lastFrame).toContain('75%');
  // Nothing threw and the app is alive after the resize: the canvas takes the keys and
  // `x` arms the delete, which the header says on screen (a later `tab` clears it). The
  // armed header is longer than the pane, so it is the second thing `fit` cuts at 60.
  await toPlugin(ui);
  await ui.press('x');
  const armedHeader = ui.backend.lastFrame.split('\n').find((line) => line.startsWith('canvas · «Pipelines»'));
  expect(armedHeader).toContain('…');
  expect(armedHeader).toContain('press x again');
  await ui.press('tab');
  expect(ui.backend.lastFrame).not.toContain('press x again');
  // Back to 120x32: the layout is computed from the new size again, not frozen narrow.
  backend.resize(120, 32);
  await settle(20);
  const wideAgain = ui.backend.lastFrame.split('\n').find((line) => line.includes('a pipeline line'));
  expect(wideAgain).toContain(long);
  // A short terminal: the body scrolls inside the pane — the header stays the surface's
  // first row, the button below the fold is not drawn over the footer, and every painted
  // line fits the terminal.
  backend.resize(120, 12);
  await settle(20);
  const shortRows = ui.backend.lastFrame.split('\n');
  expect(shortRows.length).toBeLessThanOrEqual(12);
  for (const line of shortRows) expect(line.length).toBeLessThanOrEqual(120);
  const headerAt = shortRows.findIndex((line) => line.includes('canvas · «Pipelines»'));
  const barAt = shortRows.findIndex((line) => line.includes('75%'));
  expect(headerAt).toBeGreaterThanOrEqual(0);
  expect(headerAt).toBeLessThan(barAt);
  expect(ui.backend.lastFrame).not.toContain('check again');
});

// ── Saved layouts (Task 9) ───────────────────────────────────────────────────
// A recipe is a stored tree, not a canvas: one turn draws a layout, keeps it, deletes
// the canvas, and draws the recipe under another id. The cache behind it is the host's
// own (in memory under `bun test`); reuse across restarts is the cache's behaviour, not
// this plugin's, and the host's own tests cover it.
test('a layout is saved as a recipe and drawn again from it — the frame shows the recipe\'s text', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines',
      tree: ['Box', { flexDirection: 'column' }, ['Text', {}, 'the recipe text'], ['input', { bind: 'branch', value: 'main' }]] } },
     { tool: 'canvas_save', args: { canvas: 'ci', template: 'pipeline' } },
     { tool: 'canvas_delete', args: { canvas: 'ci' } },
     { tool: 'canvas_draw', args: { canvas: 'ci2', template: 'pipeline' } },
     { tool: 'canvas_open', args: { canvas: 'ci2' } }],
    [{ text: 'Kept.' }],
  );
  const ui = await boot(model);
  await turn(ui, 'keep this layout');
  await settleUntil(ui, () => ui.backend.lastFrame.includes('the recipe text'));
  // The recipe carried the title, and the surface is up on the canvas drawn from it.
  expect(ui.backend.lastFrame).toContain('canvas · «Pipelines»');
  // The save's answer names the recipe with its scope, so the model reads where it went.
  const toolTexts = model.requests.flatMap((request) => (request.messages as Array<{ role: string; content?: unknown }>)
    .filter((message) => message.role === 'tool')
    .map(msgText));
  const saved = toolTexts.filter((text) => text.includes('saved «'));
  expect(saved).toHaveLength(1);
  expect(saved[0]!).toContain('pipeline');
});

// ── The demo (Task 10) ───────────────────────────────────────────────────────
// The design's pipeline panel, in the shape `gitlab`'s tools really return
// (`gitlab_mr_status`: the latest pipeline and its failed jobs; `glab_api`:
// `projects/:id/pipelines/:id/jobs`) — nothing domain-specific in this plugin, and no
// network: the script stands in for the model's calls. The first draw's tree is the
// vocabulary's own example, line for line; the second changes only the data in it.
//
// Its own boot, wider than the file's: the whole panel has to be on screen at a glance
// for the frame to show it, and at 110 columns the chat docks BELOW the canvas, leaving
// the body one row short of this tree (the ScrollBox scrolls, and the demo is about
// reading it without scrolling). Beside the canvas is also how the design draws it.
const bootDemo = (model: ScriptedModel) => bootApp(model, 140, 32, (make) => [buildCanvasPlugin({ make, config: {} })], {}, { chatMode: 'panel' });

test('a pipeline is drawn from gitlab-shaped data and redrawn after a press', async () => {
  const pipeline = (job: string, passed: number) => ['Box', { flexDirection: 'column', gap: 1 },
    ['badge', { text: 'failed · 2m', tone: 'error' }],
    ['rows', { items: [{ label: 'project', value: 'portals/frontend-services/prices-index' }, { label: 'commit', value: 'a3f19c2' }] }],
    ['progress', { label: 'jobs passed', value: passed, tone: 'warn' }],
    ['tasks', { items: [{ text: 'build', state: 'done' }, { text: 'lint', state: 'done' }, { text: 'test:unit', state: job }, { text: 'deploy:stage', state: 'queued' }] }],
    ['Box', { flexDirection: 'row', gap: 2 },
      ['input', { bind: 'branch', label: 'branch', value: 'feature-MP-123' }],
      ['check', { bind: 'watch', label: 'watch it', value: true }],
      ['button', { label: 'check again', action: 'check the pipeline for this branch again' }]],
    ['Link', { url: 'https://gitlab…/pipelines/1234' }]];
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines · prices-index', owner: 'reviewer', tree: pipeline('running', 75) } },
     { tool: 'canvas_open', args: { canvas: 'ci' } }],
    [{ text: 'Here it is.' }],
    // The press answers with the pipeline as it is now: the running job failed.
    [{ tool: 'canvas_draw', args: { canvas: 'ci', tree: pipeline('failed', 66) } }],
  );
  const ui = await bootDemo(model);
  await turn(ui, 'draw my pipeline');
  await settleUntil(ui, () => ui.backend.lastFrame.includes('Pipelines · prices-index'));
  const drawn = ui.backend.lastFrame;
  // The picture a person reads instead of the JSON — every composite in it, read from
  // the frame rather than from the tree: the badge's status, `rows`' labels and values,
  // the bar and its percentage, the jobs and the running one's glyph, the field and the
  // checkbox, the link's address (no hyperlink on the test surface, so the address is
  // what is drawn) and the way to ask again.
  expect(drawn).toContain('failed · 2m');
  expect(drawn).toContain('project');
  expect(drawn).toContain('commit');
  expect(drawn).toContain('a3f19c2');
  expect(drawn).toContain('75%');
  expect(drawn).toContain('build');
  expect(drawn).toContain('● test:unit');
  expect(drawn).toContain('branch');
  expect(drawn).toContain('feature-MP-123');
  expect(drawn).toContain('watch it');
  expect(drawn).toContain('https://gitlab…/pipelines/1234');
  expect(drawn).toContain('check again');
  await toPlugin(ui);
  // Tab to the button (the field, the checkbox, then the button — tree order) and press
  // it: Enter on a focused button is the keyboard path the footer promises.
  await ui.press('tab', 'tab', 'tab');
  await ui.press('return');
  // The press is one message: the agent's follow-up request carries the values as the
  // person left them, and its answer redraws the canvas with the jobs as they are now.
  await settleUntil(ui, () => ui.backend.lastFrame.includes('66%'));
  const answered = model.requests.at(-1)!.messages as Array<{ role: string; content?: unknown }>;
  const pressed = answered.filter((message) => msgText(message).includes('pressed «check again»'));
  expect(pressed).toHaveLength(1);
  expect(msgText(pressed[0]!)).toContain('branch: feature-MP-123 · watch: on');
  // The redraw's data change, proven on the frame rather than by a string both trees
  // share: the percentage fell and the job the press had running now failed. The
  // strings the press did not change are gone from the frame with it.
  expect(ui.backend.lastFrame).toContain('66%');
  expect(ui.backend.lastFrame).toContain('✗ test:unit');
  expect(ui.backend.lastFrame).not.toContain('● test:unit');
  expect(ui.backend.lastFrame).not.toContain('75%');
});
