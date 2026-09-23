// Scripted conversations for looking at the chat UI.
//
//   bun scripts/ui-frames.ts                 # every scenario
//   bun scripts/ui-frames.ts streaming bg    # only these
//   bun scripts/ui-frames.ts --size 120x36 streaming
//   bun scripts/ui-frames.ts --color input   # real ANSI colours, for your terminal
//   bun scripts/ui-frames.ts --styles input  # colours spelled out per row, for a log or a diff
//
// Each scenario boots the REAL app on a test backend, plays a scripted model
// (no network, no key, no cost) and prints the frame at named checkpoints. It is
// how a display change gets looked at before and after: the same script, the same
// moments, two outputs to compare. It asserts nothing — behaviour belongs in the
// tests, this is for eyes.
//
// A model turn is a list of steps: text (streamed in chunks), a tool call, or a
// `hold` that freezes the stream until the scenario releases it — which is how a
// frame is taken "while the answer is still coming".

import { ScriptedModel, bootApp, settle } from '../src/__tests__/helpers/scripted.ts';
import type { Make } from '../src/loader/plugin.ts';

const argv = process.argv.slice(2);
const sizeAt = argv.indexOf('--size');
const [W, H] = (sizeAt >= 0 ? argv[sizeAt + 1]! : '100x28').split('x').map(Number) as [number, number];
const COLOR = argv.includes('--color');
const STYLES = argv.includes('--styles');
const wanted = argv.filter((a, i) => !a.startsWith('--') && !(sizeAt >= 0 && i === sizeAt + 1));

// ─── styled output ────────────────────────────────────────────────────────────
type CellStyle = { fg?: string; bg?: string; bold?: boolean; dim?: boolean; underline?: boolean; inverse?: boolean };
type CellBuffer = { width: number; height: number; get(x: number, y: number): { char: string; style: CellStyle } };
const NAMED: Record<string, number> = { black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7, gray: 8, grey: 8 };
const sgrColor = (c: string, bg: boolean): string => {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) { const n = parseInt(hex[1]!, 16); return `${bg ? 48 : 38};2;${n >> 16};${(n >> 8) & 255};${n & 255}`; }
  const n = NAMED[c.toLowerCase()];
  if (n === undefined) return '';
  return n === 8 ? String(bg ? 100 : 90) : String((bg ? 40 : 30) + n);
};
const sgr = (st: CellStyle) => [st.bold && '1', st.dim && '2', st.underline && '4', st.inverse && '7', st.fg && sgrColor(st.fg, false), st.bg && sgrColor(st.bg, true)].filter(Boolean).join(';');
const label = (st: CellStyle) => [st.fg && `fg=${st.fg}`, st.bg && `bg=${st.bg}`, st.bold && 'bold', st.dim && 'dim', st.underline && 'underline', st.inverse && 'inverse'].filter(Boolean).join(' ');

function styledFrame(buf: CellBuffer): string {
  const rows: string[] = [];
  for (let y = 0; y < buf.height; y++) {
    let ansi = '';
    let plain = '';
    const runs: string[] = [];
    let open = '';
    let from = 0;
    for (let x = 0; x <= buf.width; x++) {
      const cell = x < buf.width ? buf.get(x, y) : null;
      const now = cell ? label(cell.style) : '\u0000';
      if (now !== open) {
        if (open && plain.slice(from).trim()) runs.push(`${from}–${x - 1} ${open}`);
        open = now; from = x;
      }
      if (cell) { const code = sgr(cell.style); ansi += code ? `\x1b[${code}m${cell.char || ' '}\x1b[0m` : (cell.char || ' '); plain += cell.char || ' '; }
    }
    rows.push(COLOR ? ansi.replace(/(\s|\x1b\[0m)+$/, '\x1b[0m') : `${plain.replace(/\s+$/, '')}${runs.length ? `\n      ⟨${runs.join(' ⟩⟨')} ⟩` : ''}`);
  }
  while (rows.length && !rows.at(-1)!.replace(/\x1b\[[0-9;]*m/g, '').trim()) rows.pop();
  return rows.join('\n');
}

// ─── the rig ──────────────────────────────────────────────────────────────────
async function boot(model: ScriptedModel, guests?: (make: Make) => never[], extra: Record<string, unknown> = {}) {
  const ui = await bootApp(model, W, H, guests, extra);
  const frame = (title: string) => {
    const buf = ui.backend.lastBuffer;
    if ((COLOR || STYLES) && buf) { console.log(`\n┏━━ ${title}\n${styledFrame(buf)}`); return; }
    const lines = ui.backend.lastFrame.split('\n').map((l) => l.replace(/\s+$/, ''));
    while (lines.length && !lines.at(-1)) lines.pop();
    console.log(`\n┏━━ ${title}\n${lines.join('\n')}`);
  };
  return { ...ui, frame };
}

// A guest whose one tool edits a file that exists only here and reports the change, so
// a turn has a ✎ block in it. No `write` flag: the frames are about the turn, not the y/n.
const editor = (make: Make) => [make('clone', {
  tools: [{
    id: 'clone',
    tools: [{ type: 'function', function: { name: 'edit_app', description: 'Edit app.ts.', parameters: { type: 'object', properties: { b: { type: 'number' } } } } }],
    exec: async (_name: string, args: Record<string, unknown>, ctx: Record<string, unknown>) => {
      (ctx as { reportChange?: (c: unknown) => void }).reportChange?.({ title: 'clone/app.ts', before: 'const a = 1;\nconst b = 2;\nconst c = 3;\n', after: `const a = 1;\nconst b = ${Number(args.b)};\nconst c = 3;\n` });
      return 'edited';
    },
  }],
} as never)] as never[];

// ─── scenarios ────────────────────────────────────────────────────────────────
const scenarios: Record<string, () => Promise<void>> = {
  // The input field in every state a person meets it in.
  async input() {
    const model = new ScriptedModel();
    const ui = await boot(model);
    ui.frame('app started, chat closed');
    await ui.press('F');
    ui.frame('chat opened, field empty');
    await ui.type('a question being typed');
    ui.frame('text in the field');
    ui.app.unmount();
  },

  // Slash-command completion inside the field, and the caret moved back into text.
  async completion() {
    const ui = await boot(new ScriptedModel());
    await ui.press('F');
    await ui.type('/');
    ui.frame('"/" typed: the first command is offered, the others are named');
    await ui.type('co');
    ui.frame('"/co" typed: one candidate left');
    await ui.press('tab');
    ui.frame('Tab pressed: the command is taken');
    await ui.press('escape');
    await ui.type('move the caret back');
    await ui.press('left', 'left', 'left', 'left');
    ui.frame('caret inside the text: both sides are drawn alike');
    ui.app.unmount();
  },

  // A multi-line draft: two thoughts separated by a blank line.
  async multiline() {
    const ui = await boot(new ScriptedModel());
    await ui.press('F');
    await ui.type('first thought');
    ui.backend.press({ name: 'return', shift: true });
    ui.backend.press({ name: 'return', shift: true });
    await ui.type('second thought');
    ui.frame('two thoughts with a blank line between them');
    ui.app.unmount();
  },

  // What happens to a message sent WHILE an answer is still streaming.
  async streaming() {
    const model = new ScriptedModel();
    model.script([{ text: 'Looking at the branch now, ' }, { hold: true }, { text: 'and it is three commits ahead of master.' }], [{ text: 'Second answer.' }]);
    const ui = await boot(model);
    await ui.press('F');
    await ui.type('how far is my branch from master');
    await ui.press('return');
    ui.frame('answer streaming, field idle');
    await ui.type('and is CI green');
    ui.frame('typed while the answer streams');
    await ui.press('return');
    ui.frame('pressed Enter while the answer streams');
    model.release();
    await settle(16);
    ui.frame('first answer finished');
    console.log(`   requests sent to the model so far: ${model.requests.length}`);
    ui.app.unmount();
  },

  // A tool-using turn: the trail of calls under the answer.
  async tools() {
    const model = new ScriptedModel();
    model.script(
      [{ text: 'Let me put that in the plan.' }, { tool: 'todo', args: { action: 'add', items: ['read the diff', 'run the tests', 'write the summary'] } }],
      [{ tool: 'todo', args: { action: 'start', text: 'read the diff' } }],
      [{ text: 'Plan is set and the first item is in progress.' }],
    );
    const ui = await boot(model);
    await ui.press('F');
    await ui.type('plan the review of this branch');
    await ui.press('return');
    await settle(20);
    ui.frame('answer with a tool trail and a live plan');
    ui.app.unmount();
  },

  // One turn in time order: text, a write, two more steps, the answer. In `step` each
  // run of steps folds to one row where it began; `^o` opens them in place; `open`
  // draws them all in the normal colour.
  async turn() {
    const model = new ScriptedModel();
    const script = () => model.script(
      [{ text: 'I will change b to 42.' }, { tool: 'edit_app', args: { b: 42 } }],
      [{ text: 'Let me check the rest of the file.' }, { hold: true }, { tool: 'datetime', args: {} }],
      [{ text: 'All clear, nothing else uses b.' }, { tool: 'datetime', args: {} }],
      [{ text: 'Done: b is now ' }, { hold: true }, { text: '42.' }],
    );
    script();
    const ui = await boot(model, editor);
    await ui.press('F');
    await ui.type('set b to 42');
    await ui.press('return');
    await settle(20);
    ui.frame('step: a round streaming after the write — dim, a live mark, no ƒ');
    model.release();
    await settle(20);
    ui.frame('step: the answer streaming under the folded run');
    model.release();
    await settle(20);
    ui.frame('step: the turn done — one row for the run of two steps');
    ui.backend.press({ name: 'o', ctrl: true });
    await settle(6);
    ui.frame('^o: every step in full, dim, where it happened');
    ui.backend.press({ name: 'o', ctrl: true });
    await settle(6);
    await ui.type('/notes open');
    await ui.press('return');
    await settle(6);
    ui.frame('/notes open: the same turn, every step in the normal colour');
    ui.app.unmount();
  },

  // A background task: how its result lands in the conversation.
  async bg() {
    const model = new ScriptedModel();
    model.script(
      [{ tool: 'background', args: { task: 'count the TODO comments in the repo' } }],
      [{ text: 'Started it in the background.' }],
      [{ text: 'There are 14 TODO comments.' }], // the nested run
      [{ text: 'The background task finished: 14 TODO comments.' }], // the reply to its result
    );
    const ui = await boot(model);
    await ui.press('F');
    await ui.type('count the TODOs in the background');
    await ui.press('return');
    await settle(12);
    ui.frame('task handed to the background');
    await ui.type('meanwhile, a new question');
    ui.frame('typing while the background task runs');
    await settle(40);
    ui.frame('background result arrived');
    ui.app.unmount();
  },

  // The two pauses: a structured question, and a write confirmation.
  async pauses() {
    const model = new ScriptedModel();
    model.script(
      [{ tool: 'ask_user', args: { questions: [{ question: 'Rebase or merge?', header: 'Strategy', options: [{ label: 'rebase (Recommended)', description: 'Linear history' }, { label: 'merge', description: 'Keeps the branch shape' }] }] } }],
      [{ tool: 'memory', args: { action: 'add', text: 'This repo prefers rebase over merge.' } }],
      [{ text: 'Noted.' }],
    );
    const ui = await boot(model);
    await ui.press('F');
    await ui.type('how should I integrate this');
    await ui.press('return');
    await settle(12);
    ui.frame('ask_user open');
    await ui.press('return');
    await settle(12);
    ui.frame('after the answer (a write may be asking for confirmation)');
    ui.app.unmount();
  },

  // Answering a question in one's own words: typing opens the field, wherever the
  // cursor was on the list.
  async answer() {
    const model = new ScriptedModel();
    model.script(
      [{ tool: 'ask_user', args: { questions: [{ question: 'Which branch?', options: [{ label: 'master' }, { label: 'develop' }] }] } }],
      [{ text: 'Using it.' }],
    );
    const ui = await boot(model);
    await ui.press('F');
    await ui.type('which branch should I use');
    await ui.press('return');
    await settle(12);
    ui.frame('the list, with the rule on its hint line');
    await ui.type('feature/ABC-1');
    ui.frame('typed: the field opened on the first character, caret at the end');
    await ui.press('left', 'left', 'left');
    ui.frame('the caret moves inside the text');
    ui.app.unmount();
  },

  // What a confirmed run_command leaves in the chat.
  async runOutput() {
    const model = new ScriptedModel();
    model.script(
      [{ tool: 'run_command', args: { command: 'for i in $(seq 1 30); do echo "line $i of the output"; done' } }],
      [{ text: 'Thirty lines, the last of them `line 30 of the output`.' }],
    );
    const ui = await boot(model);
    await ui.press('F');
    await ui.type('print thirty lines');
    await ui.press('return');
    await settle(12);
    ui.frame('the y/n, with the command itself on it');
    await ui.press('y');
    await settle(40);
    ui.frame('confirmed: the block, folded to its last lines');
    ui.backend.press({ name: 'r', ctrl: true });
    await settle(6);
    ui.frame('^r unfolds the whole of it');
    ui.app.unmount();
  },

  // A command the model runs, while it runs and after: one line, opened by a click,
  // still open when it ends.
  async 'live-command'() {
    const model = new ScriptedModel();
    model.script([{ tool: 'run_command', args: { command: 'echo one; sleep 1; echo two' } }], [{ text: 'Both printed.' }]);
    const ui = await boot(model);
    const until = async (ok: () => boolean) => { for (let i = 0; i < 400 && !ok(); i++) await settle(1); };
    await ui.press('F');
    await ui.type('run it');
    await ui.press('return');
    await until(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
    await ui.press('y');
    await until(() => ui.backend.lastFrame.includes('echo one; sleep 1; echo two ·'));
    ui.frame('running, folded: one line and its clock');
    const y = ui.backend.lastFrame.split('\n').findIndex((r) => r.includes('echo one; sleep 1'));
    ui.backend.mouse('down', 12, y);
    ui.backend.mouse('up', 12, y);
    // Not `settle(6)` — the click opens the block at once, but its first printed
    // line only lands once the live view's own 200ms coalesce flush runs.
    await until(() => ui.backend.lastFrame.includes('│ one'));
    ui.frame('running, opened: what it printed so far');
    await until(() => ui.backend.lastFrame.includes('Both printed.'));
    ui.frame('finished: still open, and how it ended');
    ui.app.unmount();
  },
};

const names = wanted.length ? wanted : Object.keys(scenarios);
for (const name of names) {
  const run = scenarios[name];
  if (!run) { console.error(`unknown scenario "${name}" — have: ${Object.keys(scenarios).join(', ')}`); process.exit(2); }
  console.log(`\n\n════════ ${name} (${W}×${H}) ════════`);
  await run();
}
process.exit(0);
