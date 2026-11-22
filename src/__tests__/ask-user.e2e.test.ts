// `ask_user` end to end through the real TUI: the model calls the tool → the
// question block takes the input's place → key presses answer it → the answer
// reaches the model as the tool result. Only the network is faked.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestBackend, flush } from '@flowtty/core/testing';
import { loadPlugins } from '../loader/build';
import { assembleToolRegistry } from '../loader/tools';
import { renderApp } from '../runtime/app';
import { renderChatModal, renderHelp, renderLogModal, renderReminder } from '../views/modals';
import { ScriptedModel, bootApp, settle as settleUi } from './helpers/scripted';
import { listTree } from './helpers/session-files';

const realFetch = globalThis.fetch;
// The plan is module-level state: leave none behind for the suites that follow.
afterEach(() => { globalThis.fetch = realFetch; });

const sse = (...chunks: unknown[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join(''), { headers: { 'content-type': 'text/event-stream' } });
const settle = async () => { for (let i = 0; i < 8; i++) { await flush(); await new Promise((r) => setTimeout(r, 5)); } };

// The style of the cell where `text` starts (plus `offset` cells) — the caret cell is
// drawn inverse, so this is how a test tells where the field's caret rests.
function styleAt(backend: { lastBuffer: { get(x: number, y: number): { style: { inverse?: boolean; dim?: boolean } } } | null; lastFrame: string }, text: string, offset = 0) {
  const rows = backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes(text));
  if (y < 0) throw new Error(`"${text}" is not on screen:\n${backend.lastFrame}`);
  return backend.lastBuffer!.get(rows[y]!.indexOf(text) + offset, y).style;
}

test.each([[110, 40, 'window'], [100, 22, 'window'], [100, 22, 'panel']] as const)('the model asks, the person picks with the keyboard, the model gets the answer (%ix%i, %s)', async (cols, rows, mode) => {
  // The short screen carries a plan too: the question block must still show its
  // last row and its key hints — budgeting it as a one-line input field instead
  // would lose "Other…" and the hint line below the frame. Docked at the bottom of 22
  // rows, the panel's 12 cannot hold it and growing it would leave the plugin less
  // than its least: the chat is a window until the question is answered.
  process.env.LLM_TOKEN = 't';
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (bodies.length === 1) {
      const args = JSON.stringify({ questions: [{ question: 'Rebase or merge?', header: 'Strategy', options: [{ label: 'rebase (Recommended)', description: 'Linear history' }, { label: 'merge', description: 'Keeps the branch shape' }] }] });
      return sse(
        // The plan is the chat's own now, so it is the MODEL that puts one there — in
        // the same round, before it asks.
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_plan', function: { name: 'todo', arguments: JSON.stringify({ action: 'set', todos: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] }) } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_ask', function: { name: 'ask_user', arguments: args } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      );
    }
    return sse({ choices: [{ delta: { content: 'Merging then.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  }) as typeof fetch;

  const config: Record<string, unknown> = { ai: { baseUrl: 'http://llm.test', model: 'm' }, plugins: { assistant: { mode } } };
  const repo = { enabledPlugins: async () => [], list: async () => [] } as any;
  const renders = { chat: renderChatModal, help: renderHelp, log: renderLogModal, reminder: renderReminder };
  const plugins = await loadPlugins({ config, repo, renders: renders as any });
  const tools = assembleToolRegistry({ plugins, config, repo });
  const backend = new TestBackend(cols, rows);
  const handle = await renderApp(backend, { plugins, config, tools, onExit: () => {} });
  await settle();

  backend.press({ name: 'F', shift: true });
  await settle();
  backend.type('how should I integrate this branch');
  backend.press({ name: 'return' });
  await settle();

  // The question replaced the input field; nothing was answered for the person.
  expect(backend.lastFrame).toContain('Strategy — Rebase or merge?');
  expect(backend.lastFrame).toContain('1. rebase (Recommended)');
  expect(backend.lastFrame).toContain('Linear history');
  expect(backend.lastFrame).toContain('3. Other…');
  expect(backend.lastFrame).toContain('Esc dismiss');
  expect(bodies).toHaveLength(1);
  // Whole: the question's frame closes below its hint, inside the chat's own frame.
  const lines = backend.lastFrame.split('\n');
  const hintAt = lines.findIndex((l) => l.includes('Esc dismiss'));
  expect(lines[hintAt + 1]).toMatch(/╰─+╯/);
  expect(lines.slice(hintAt + 2).some((l) => /╰─+╯/.test(l))).toBe(true);

  backend.press({ name: 'down' });
  backend.press({ name: 'return' });
  await settle();

  expect(bodies).toHaveLength(2);
  const toolResult = bodies[1].messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_ask');
  expect(toolResult).toMatchObject({ tool_call_id: 'call_ask' });
  expect(toolResult.content).toContain('Rebase or merge? → merge');
  // Answered, the panel is docked again at its own 12 rows: the three-item plan gives
  // way to one row, so the field and the answer are on screen as in a window.
  expect(backend.lastFrame).toContain('Merging then.');
  if (mode === 'panel') {
    expect(backend.lastFrame.split('\n')[rows - 12]).toContain('╭─ ƒ Flow Assist');
    expect(backend.lastFrame).toContain('▸ plan · ☐ one');
    expect(backend.lastFrame).toContain('Esc Esc collapse');
  }
  expect(backend.lastFrame).not.toContain('ask_user');
  // The question the person answered stays where it was asked — its own block, not a
  // trail line that does not even name the question. The model already has the answer
  // as the tool's result. A 12-row docked panel has room for the turn's tail alone.
  if (mode !== 'panel') {
    expect(backend.lastFrame).toContain('? Strategy — Rebase or merge?');
    expect(backend.lastFrame).toContain('→ merge');
  }
  handle.unmount();
});

test('the narration that led into the question reads in full while it waits, and folds once answered', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: 'Checking the branch shape first.', tool: 'ask_user', args: { questions: [{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }] } }],
    [{ text: 'Using it.' }],
  );
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  await ui.type('which branch should I use?');
  await ui.press('return');
  await settleUi(15);

  // The step that led into the ask is drawn unfolded and at full ink: the context the
  // question is read against, not one dim chrome row.
  expect(ui.backend.lastFrame).toContain('Checking the branch shape first.');
  expect(ui.backend.lastFrame).not.toContain('▸ Checking the branch shape first.');
  expect(styleAt(ui.backend, 'Checking the branch shape first.').dim).toBeFalsy();

  // Answered, it folds where it stands, with the turn's own display again.
  ui.backend.press({ name: 'return' });
  await settleUi(20);
  expect(ui.backend.lastFrame).toContain('▸ Checking the branch shape first.');
  ui.app.unmount();
});

test('typing starts the answer, the field takes a paste, and the model is sent the whole text', async () => {
  // Answering in one's own words meant walking to the "Other…" row first, and the
  // field there dropped a paste entirely — so a pasted path could not be an answer.
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_user', args: { questions: [{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }] } }],
    [{ text: 'Using it.' }],
  );
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  await ui.type('which branch should I use?');
  await ui.press('return');
  await settleUi(15);
  expect(ui.backend.lastFrame).toContain('Which branch?');
  expect(ui.backend.lastFrame).toContain('type your own words');

  await ui.type('use ');
  expect(ui.backend.lastFrame).toContain('› use'); // the field opened on the first letter
  ui.backend.paste('feature/ABC-1\nplease');
  await settleUi(4);
  await ui.type(' now');
  await ui.press('return');
  await settleUi(20);

  expect(model.requests).toHaveLength(2);
  const result = (model.requests[1]!.messages as { role: string; content?: string }[]).find((m) => m.role === 'tool');
  // The paste went in whole — its line break kept, as the chat's field keeps it (it
  // used to be flattened to a space when the field was one line) — and it neither
  // answered the question by itself nor fired a binding.
  expect(String(result?.content)).toContain('use feature/ABC-1\nplease now');
  // Kept as it was answered, in the person's own words.
  expect(ui.backend.lastFrame).toContain('? Which branch?');
  expect(ui.backend.lastFrame).toContain('→ use feature/ABC-1');
  expect(ui.backend.lastFrame).toContain('please now');
  ui.app.unmount();
});

test('the arrows move the caret inside the free-text answer', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_user', args: { questions: [{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }] } }],
    [{ text: 'Fine.' }],
  );
  const ui = await bootApp(model, 110, 30);
  const fieldRow = () => ui.backend.lastFrame.split('\n').filter((r) => r.includes('› ')).at(-1) ?? '';
  await ui.press('F');
  await ui.type('which branch should I use?');
  await ui.press('return');
  await settleUi(15);

  // The first printable key opens the field with itself in it.
  await ui.type('abc');
  expect(fieldRow()).toContain('› abc');
  await ui.press('left');
  await ui.type('X');
  // The letter went in at the caret, not at the end.
  expect(fieldRow()).toContain('› abXc');
  // The caret is the cell it rests on: the character AFTER `X`, drawn inverse.
  expect(styleAt(ui.backend, '› abXc', 5).inverse).toBe(true);
  expect(styleAt(ui.backend, '› abXc', 4).inverse).toBeFalsy();

  // And what the field answers with is the edited text.
  await ui.press('return');
  await settleUi(20);
  expect(model.requests).toHaveLength(2);
  const result = (model.requests[1]!.messages as { role: string; content?: string }[]).find((m) => m.role === 'tool');
  expect(String(result?.content)).toContain('abXc');
  ui.app.unmount();
});

// A regression guard for the field's word wrap (flowtty alpha.38): the answer wraps at
// words, the same break the message gets when it is printed. At width 110 the answer
// field is 95 columns wide, so this sentence wraps inside its `september october
// november` cluster — whatever the exact width, one of the three would tear mid-word
// if the rows packed letters.
test('the answer field wraps at words — its long words stay whole on the rows', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_user', args: { questions: [{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }] } }],
    [{ text: 'Fine.' }],
  );
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  await ui.type('which branch should I use?');
  await ui.press('return');
  await settleUi(15);
  await ui.type('alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike september october november oscar papa quebec romeo');
  await settleUi(4);
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('september');
  expect(frame).toContain('october');
  expect(frame).toContain('november');
  ui.app.unmount();
});

test('an answered question is saved with the session and drawn again when it is continued', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ask-sessions-'));
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_user', args: { questions: [{ question: 'Which branch?', header: 'Branch', options: [{ label: 'master' }, { label: 'develop' }] }] } }],
    [{ text: 'Using it.' }],
  );
  const ui = await bootApp(model, 110, 30, undefined, { sessions: { dir } });
  await ui.press('F');
  await ui.type('which branch should I use?');
  await ui.press('return');
  await settleUi(15);
  await ui.press('return');
  await settleUi(20);
  await new Promise((r) => setTimeout(r, 400)); // the save is 250 ms after the turn
  ui.app.unmount();

  // A restart continues the session: what the person answered is still there.
  const next = new ScriptedModel();
  next.script([{ text: 'Ready.' }]);
  const ui2 = await bootApp(next, 110, 30, undefined, { sessions: { dir } });
  await settleUi(10);
  await ui2.press('F');
  await settleUi(10);
  expect(ui2.backend.lastFrame).toContain('? Branch — Which branch?');
  expect(ui2.backend.lastFrame).toContain('→ master');
  ui2.app.unmount();
});

// ── several questions: pages, drafts, one submit ─────────────────────────────

const twoQuestions = {
  questions: [
    { question: 'Rebase or merge?', header: 'Strategy', options: [{ label: 'rebase' }, { label: 'merge' }] },
    { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'lint' }, { label: 'tests' }] },
  ],
};

const askedOnce = async (ui: Awaited<ReturnType<typeof bootApp>>, prompt: string) => {
  await ui.press('F');
  await ui.type(prompt);
  await ui.press('return');
  await settleUi(15);
};

test('a two-question call walks pages and submits once', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'ask_user', args: twoQuestions }], [{ text: 'On it.' }]);
  const ui = await bootApp(model, 110, 40);
  await askedOnce(ui, 'how should I integrate this branch');

  // The call opens on its first page and the strip names every page there is: a tab
  // per question and the submit page, on ONE row.
  expect(ui.backend.lastFrame).toContain('? 1/2 · Strategy — Rebase or merge?');
  const strip = ui.backend.lastFrame.split('\n').find((r) => r.includes('Submit')) ?? '';
  expect(strip).toContain('Strategy');
  expect(strip).toContain('Checks');

  // `1` answers the first question with its first option and moves straight on.
  await ui.press('1');
  await settleUi(4);
  expect(ui.backend.lastFrame).toContain('? 2/2 · Checks — Which checks?');
  expect(ui.backend.lastFrame).toContain('✓ Strategy');

  // `right` walks to the submit page, `left` back — the pages are walked freely.
  await ui.press('right');
  await settleUi(4);
  expect(ui.backend.lastFrame).toContain('? Submit');
  expect(ui.backend.lastFrame).toContain('Strategy — Rebase or merge?');
  await ui.press('left');
  await settleUi(4);
  expect(ui.backend.lastFrame).toContain('? 2/2 · Checks — Which checks?');

  // Back to the first question, its pick changed: the LAST state of a draft is what
  // the call sends, and nothing is committed by walking away.
  await ui.press('left');
  await settleUi(4);
  expect(ui.backend.lastFrame).toContain('? 1/2 · Strategy — Rebase or merge?');
  await ui.press('2');
  await settleUi(4);
  expect(ui.backend.lastFrame).toContain('? 2/2 · Checks — Which checks?');
  await ui.press('2'); // a multi-select digit toggles: no page move
  await settleUi(4);
  expect(ui.backend.lastFrame).toContain('[x] 2. tests');
  await ui.press('right', 'right');
  await settleUi(4);

  // The submit page sums the drafts: the first pick was replaced, the second stands.
  expect(ui.backend.lastFrame).toContain('? Submit');
  expect(ui.backend.lastFrame).toContain('merge');
  // The first answer the page sent is gone: the draft's last state is what will go.
  expect(ui.backend.lastFrame).not.toContain('rebase');
  expect(ui.backend.lastFrame).toContain('tests');
  // Still pending: the call has no row in the tool trail, and the model has been sent
  // nothing since the call arrived.
  const trail = ui.backend.lastFrame.split('\n').filter((r) => r.includes('ask_user') && r.includes('▸'));
  expect(trail).toEqual([]);
  expect(ui.backend.lastFrame).toContain('⚙ ask_user');
  expect(model.requests).toHaveLength(1);

  await ui.press('return');
  await settleUi(20);

  // Both answers are kept where they were asked, in their final state.
  expect(ui.backend.lastFrame).toContain('? Strategy — Rebase or merge?');
  expect(ui.backend.lastFrame).toContain('→ merge');
  expect(ui.backend.lastFrame).toContain('? Checks — Which checks?');
  expect(ui.backend.lastFrame).toContain('→ tests');
  expect(ui.backend.lastFrame).not.toContain('ask_user');
  // The model reads the call once, and the first question's second pick is the answer:
  // one tool message, holding one copy of the result.
  expect(model.requests).toHaveLength(2);
  const toolMessages = (model.requests[1]!.messages as { role: string; content?: string }[]).filter((m) => m.role === 'tool');
  const results = toolMessages.filter((m) => String(m.content).includes('The user answered:'));
  expect(toolMessages).toHaveLength(1);
  expect(results).toHaveLength(1);
  expect(String(results[0]!.content)).toContain('The user answered:\n- Rebase or merge? → merge\n- Which checks? → tests');
  // The journal keeps one row per question, in order, as the call was answered.
  const sessionsDir = String((ui.config.sessions as { dir: string }).dir);
  const log = listTree(sessionsDir).find((n) => n.endsWith('.log.jsonl'));
  expect(log).toBeTruthy();
  const rows = fs.readFileSync(path.join(sessionsDir, log!), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((ev) => ev.t === 'row' && ev.role === 'ask');
  expect(rows.map((ev) => [ev.text, ev.answer])).toEqual([
    ['Strategy — Rebase or merge?', 'merge'],
    ['Checks — Which checks?', 'tests'],
  ]);
  ui.app.unmount();
});

test('a multi-select question sends every pick', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_user', args: { questions: [{ question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'lint' }, { label: 'types' }, { label: 'tests' }] }] } }],
    [{ text: 'Running both.' }],
  );
  const ui = await bootApp(model, 110, 30);
  await askedOnce(ui, 'what should I run?');
  expect(ui.backend.lastFrame).toContain('[ ] 1. lint');
  expect(ui.backend.lastFrame).toContain('[ ] 3. tests');

  // Space toggles the row under the cursor; Enter on one question commits the lot.
  await ui.press(' ');
  await ui.press('down', 'down');
  await ui.press(' ');
  await settleUi(4);
  expect(ui.backend.lastFrame).toContain('[x] 1. lint');
  expect(ui.backend.lastFrame).toContain('[x] 3. tests');
  await ui.press('return');
  await settleUi(20);

  expect(model.requests).toHaveLength(2);
  const result = (model.requests[1]!.messages as { role: string; content?: string }[]).find((m) => m.role === 'tool');
  expect(String(result?.content)).toContain('- Which checks? → lint, tests');
  expect(ui.backend.lastFrame).toContain('? Checks — Which checks?');
  expect(ui.backend.lastFrame).toContain('→ lint, tests');
  ui.app.unmount();
});

test("the digits and the person's own words both answer", async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_user', args: { questions: [{ question: 'Which branch?', header: 'Branch', options: [{ label: 'master' }, { label: 'develop' }] }] } }],
    [{ tool: 'ask_user', args: { questions: [{ question: 'Which port?', header: 'Port', options: [{ label: '8080' }, { label: '9090' }] }] } }],
    [{ text: 'Fine.' }],
  );
  const ui = await bootApp(model, 110, 30);
  await askedOnce(ui, 'which branch should I use?');

  // A digit answers a single question in one key, by the label the list advertises.
  await ui.press('2');
  await settleUi(20);
  expect(model.requests).toHaveLength(2);
  const byLabel = (model.requests[1]!.messages as { role: string; content?: string }[]).find((m) => m.role === 'tool');
  expect(String(byLabel?.content)).toContain('- Which branch? → develop');

  // The next question is answered in the person's own words, sent as such.
  expect(ui.backend.lastFrame).toContain('Which port?');
  await ui.type('my own');
  expect(ui.backend.lastFrame).toContain('› my own');
  await ui.press('return');
  await settleUi(20);
  expect(model.requests).toHaveLength(3);
  const typed = (model.requests[2]!.messages as { role: string; content?: string }[]).filter((m) => m.role === 'tool').at(-1);
  expect(String(typed?.content)).toContain('- Which port? → (their own words) my own');
  expect(ui.backend.lastFrame).toContain('→ my own');
  ui.app.unmount();
});

test('Esc dismisses the whole call', async () => {
  // From a page: no question is answered and every kept row says so.
  const fromPage = new ScriptedModel();
  fromPage.script([{ tool: 'ask_user', args: twoQuestions }], [{ text: 'Okay.' }]);
  const a = await bootApp(fromPage, 110, 40);
  await askedOnce(a, 'set this up');
  await a.press('escape');
  await settleUi(20);
  expect(fromPage.requests).toHaveLength(2);
  const dismissed = (fromPage.requests[1]!.messages as { role: string; content?: string }[]).find((m) => m.role === 'tool');
  expect(String(dismissed?.content)).toContain('dismissed the question without answering');
  expect(String(dismissed?.content)).not.toContain('The user answered:');
  expect(a.backend.lastFrame).toContain('? Strategy — Rebase or merge?');
  expect(a.backend.lastFrame).toContain('? Checks — Which checks?');
  expect(a.backend.lastFrame.match(/→ dismissed/g)).toHaveLength(2);
  a.app.unmount();

  // From the submit page: the call is answered by walking to the end and walking out.
  const fromSubmit = new ScriptedModel();
  fromSubmit.script([{ tool: 'ask_user', args: twoQuestions }], [{ text: 'Okay.' }]);
  const b = await bootApp(fromSubmit, 110, 40);
  await askedOnce(b, 'set this up');
  await b.press('right', 'right');
  await settleUi(4);
  expect(b.backend.lastFrame).toContain('? Submit');
  await b.press('escape');
  await settleUi(20);
  expect(fromSubmit.requests).toHaveLength(2);
  const out = (fromSubmit.requests[1]!.messages as { role: string; content?: string }[]).find((m) => m.role === 'tool');
  expect(String(out?.content)).toContain('dismissed the question without answering');
  expect(b.backend.lastFrame.match(/→ dismissed/g)).toHaveLength(2);
  b.app.unmount();
});

test('each question keeps its own block: what was picked, and what was dismissed', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_user', args: { questions: [
      { question: 'Which branch?', header: 'Branch', options: [{ label: 'master' }, { label: 'develop' }] },
      { question: 'Which checks?', options: [{ label: 'lint' }, { label: 'tests' }] },
    ] } }],
    [{ text: 'Fine.' }],
  );
  const ui = await bootApp(model, 110, 40);
  await ui.press('F');
  await ui.type('set this up');
  await ui.press('return');
  await settleUi(15);
  await ui.press('return'); // the first question: master
  await settleUi(4);
  await ui.press('escape'); // the second: dismissed
  await settleUi(20);

  expect(ui.backend.lastFrame).toContain('? Branch — Which branch?');
  expect(ui.backend.lastFrame).toContain('→ master');
  expect(ui.backend.lastFrame).toContain('? Which checks?');
  expect(ui.backend.lastFrame).toContain('→ dismissed');
  expect(ui.backend.lastFrame).not.toContain('ask_user');
  // The model is told the dismissal as one, and is sent no copy of the blocks: the
  // result it already has IS its record of the answer.
  expect(model.requests).toHaveLength(2);
  const sent = model.requests[1]!.messages as { role: string; content?: string }[];
  expect(sent.some((m) => m.role === 'ask')).toBe(false);
  expect(String(sent.find((m) => m.role === 'tool')?.content)).toContain('dismissed the question');
  ui.app.unmount();
});
