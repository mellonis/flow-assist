// Shell commands through the real chat: the person's `!command`, and the model's
// run_command behind the y/n. Real processes in a temp root; only the model is scripted.
// The assertions are on what the MODEL is sent as well as on the frame — a result on
// screen that never reaches the model's history looks right and is the bug.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rootDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-shell-e2e-')));
type Sent = { role: string; content: unknown }[];
const sentTo = (m: ScriptedModel) => m.requests.at(-1)!.messages as Sent;
// A real process finishes on its own clock, not the test backend's.
const settleUntil = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};

async function boot(model: ScriptedModel, root: string, extra: Record<string, unknown> = {}) {
  const ui = await bootApp(model, 110, 32, undefined, { fs: { roots: [root] }, ...extra });
  await ui.press('F');
  return ui;
}

test('!command runs in the first root, shows its output, and spends no model turn — the next message carries it', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  const ui = await boot(model, root);
  await ui.type('!echo hello; pwd');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('exit 0'));
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('$ echo hello; pwd');
  expect(frame).toContain('hello');
  expect(frame).toContain(root.replace(os.homedir(), '~'));
  expect(frame).toContain('exit 0');
  expect(model.requests).toHaveLength(0);

  model.script([{ text: 'It printed hello.' }]);
  await ui.type('what did it print?');
  await ui.press('return');
  await settle(20);
  expect(model.requests).toHaveLength(1);
  const sent = sentTo(model);
  const shell = sent.find((m) => m.role === 'user' && String(m.content).startsWith('The person ran a shell command'));
  expect(shell).toBeDefined();
  expect(String(shell!.content)).toContain(`in ${root}:`);
  expect(String(shell!.content)).toContain('$ echo hello; pwd');
  expect(String(shell!.content)).toContain('hello');
  // In order: the command before the question about it.
  expect(sent.indexOf(shell!)).toBeLessThan(sent.findIndex((m) => m.content === 'what did it print?'));
  ui.app.unmount();
});

test('Esc stops a running !command — its whole process group — and says so', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  const ui = await boot(model, root);
  await ui.type('!sleep 5; touch late.txt');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('$ sleep 5; touch late.txt'); // the status line says what runs
  const t0 = Date.now();
  await ui.press('escape');
  await settleUntil(() => ui.backend.lastFrame.includes('stopped (Esc)'));
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(ui.backend.lastFrame).toContain('stopped (Esc)');
  await wait(100);
  expect(fs.existsSync(path.join(root, 'late.txt'))).toBe(false);
  ui.app.unmount();
});

test('an empty ! runs nothing; a ! while an answer is coming is refused, not queued', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  const ui = await boot(model, root);
  await ui.type('!   ');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('! runs a shell command');
  expect(ui.backend.lastFrame).not.toContain('exit 0');

  model.script([{ text: 'Thinking' }, { hold: true }, { text: ' done.' }]);
  await ui.press('escape'); // clear the field
  await ui.type('a question');
  await ui.press('return');
  await settle(10);
  await ui.type('!touch made.txt');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('still running');
  expect(ui.backend.lastFrame).not.toContain('queued');
  model.release();
  await settle(20);
  await wait(100);
  expect(fs.existsSync(path.join(root, 'made.txt'))).toBe(false);
  ui.app.unmount();
});

test('a !command is part of the session: after a restart the model still has it', async () => {
  const root = rootDir();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-shell-sess-'));
  const first = new ScriptedModel();
  const a = await boot(first, root, { sessions: { dir } });
  await a.type('!echo remembered-output');
  await a.press('return');
  await settleUntil(() => a.backend.lastFrame.includes('exit 0'));
  await wait(350); // the debounced save
  a.app.unmount();

  const model = new ScriptedModel();
  model.script([{ text: 'Yes.' }]);
  const b = await boot(model, root, { sessions: { dir } });
  await settle(6);
  expect(b.backend.lastFrame).toContain('remembered-output');
  await b.type('still there?');
  await b.press('return');
  await settle(20);
  expect(sentTo(model).some((m) => m.role === 'user' && String(m.content).includes('remembered-output'))).toBe(true);
  // ↑ brings the command back — in shell mode now (shell-mode.e2e.test.ts covers the
  // mode itself in depth): the prompt reads `! `, not `› !`, and the field holds the
  // command with the `!` stripped, the way it was typed.
  await b.press('escape');
  await b.press('up');
  await b.press('up');
  expect(b.backend.lastFrame).toContain('! echo remembered-output');
  expect(b.backend.lastFrame).not.toContain('› !echo remembered-output');
  b.app.unmount();
});

// ─── run_command: the model's, behind the y/n ────────────────────────────────

test('run_command waits for y, shows the command itself, runs it and hands the output to the model', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'echo made > made.txt; echo tool-output-42' } }],
    [{ text: 'Done.' }],
  );
  const ui = await boot(model, root);
  await ui.type('run it');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Confirm write: run_command');
  expect(ui.backend.lastFrame).toContain('$ echo made > made.txt; echo tool-output-42');
  expect(fs.existsSync(path.join(root, 'made.txt'))).toBe(false); // nothing before the yes
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  expect(fs.existsSync(path.join(root, 'made.txt'))).toBe(true);
  const result = sentTo(model).find((m) => m.role === 'tool');
  expect(String(result?.content)).toContain('tool-output-42');
  expect(String(result?.content)).toContain('(exit 0');
  expect(String(result?.content)).toContain('not instructions');
  ui.app.unmount();
});

test('run_command declined with n runs nothing', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'touch made.txt' } }],
    [{ text: 'OK, not running it.' }],
  );
  const ui = await boot(model, root);
  await ui.type('run it');
  await ui.press('return');
  await settle(10);
  await ui.press('n');
  await settle(20);
  await wait(100);
  expect(fs.existsSync(path.join(root, 'made.txt'))).toBe(false);
  expect(String(sentTo(model).find((m) => m.role === 'tool')?.content)).toContain('declined');
  ui.app.unmount();
});

test('Esc during a confirmed run_command stops the command with the answer', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'sleep 1; touch late.txt' } }]);
  const ui = await boot(model, root);
  await ui.type('run it');
  await ui.press('return');
  await settle(10);
  await ui.press('y');
  await settle(6);
  await ui.press('escape');
  // Left alone the command would have made the file by now; the status line is no
  // proof — a long tool label truncates "Esc stops" off it.
  await wait(1500);
  await settle(4);
  expect(fs.existsSync(path.join(root, 'late.txt'))).toBe(false);
  expect(model.requests).toHaveLength(1); // the turn ended; nothing more was asked of the model
  ui.app.unmount();
});

test('a background task cannot run a command — nobody is there to say yes', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'background', args: { task: 'create a file' } }],
    [{ text: 'Started it in the background.' }],
    [{ tool: 'run_command', args: { command: 'touch made.txt' } }],
    [{ text: 'Could not.' }],
  );
  const ui = await boot(model, root);
  await ui.type('make a file in the background');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 4);
  await settle(20);
  await wait(100);
  expect(fs.existsSync(path.join(root, 'made.txt'))).toBe(false);
  const nested = model.requests[3]!.messages as Sent;
  expect(String(nested.find((m) => m.role === 'tool')?.content)).toContain('declined');
  ui.app.unmount();
});

test('ai.disabledTools ["shell"] withholds run_command; ! still works', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await boot(model, root, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', disabledTools: ['shell'] } });
  await ui.type('hi');
  await ui.press('return');
  await settle(20);
  const tools = (model.requests[0] as unknown as { tools?: { function: { name: string } }[] }).tools ?? [];
  expect(tools.map((t) => t.function.name)).not.toContain('run_command');
  await ui.type('!echo still-here');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('exit 0'));
  expect(ui.backend.lastFrame).toContain('still-here');
  ui.app.unmount();
});

// ─── what a confirmed run_command SHOWS ──────────────────────────────────────
// A command the person authorised is as visible as a write they authorised: the tool
// describes a console block (src/assistant/views.ts) and the chat draws it, the way
// the person's own `!command` leaves one. Display only — the model reads the output
// through the tool result and must never be sent a second copy of it.

// A fenced block is drawn as rows behind a dim `│ `; strip the bar to read the lines.
const unfence = (frame: string) => frame.split('\n').map((r) => r.replace(/│ /g, '')).join('\n');

test('a confirmed run_command folds to one line, and opened its output stands; the model is not sent a copy', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'echo tool-output-42; echo second-line' } }],
    [{ text: 'It printed two lines.' }],
    [{ text: 'Fine.' }],
  );
  const ui = await boot(model, root);
  await ui.type('run it');
  await ui.press('return');
  await settle(10);
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);

  // Folded: one line saying how it ended — the output itself is not on screen yet.
  // (The command's own text already contains "tool-output-42"/"second-line", so what
  // proves the OUTPUT is off screen is the bar-prefixed row it would stand behind —
  // `unfence` strips that bar, so the raw frame is checked here instead.)
  const folded = unfence(ui.backend.lastFrame);
  expect(folded).toMatch(/\$ echo tool-output-42; echo second-line · ✓ \d+\.\d s/);
  expect(ui.backend.lastFrame).not.toContain('│ tool-output-42');
  expect(ui.backend.lastFrame).not.toContain('│ second-line');
  expect(folded).toContain('It printed two lines.');

  // Opened, the output stands.
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  expect(ui.backend.lastFrame).toContain('│ tool-output-42');
  expect(ui.backend.lastFrame).toContain('│ second-line');
  ui.backend.press({ name: 'o', ctrl: true }); // back to folded
  await settle(6);

  // What the model is SENT: the tool's result once, and no block of its own. The
  // block would be a second copy of output it has already read.
  await ui.type('and now?');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 3);
  const sent = sentTo(model);
  const results = sent.filter((m) => m.role === 'tool' && String(m.content).includes('tool-output-42'));
  expect(results).toHaveLength(1);
  expect(sent.filter((m) => m.role !== 'tool').some((m) => String(m.content).includes('tool-output-42'))).toBe(false);
  expect(JSON.stringify(sent)).not.toContain('```console');
  ui.app.unmount();
});

test('a long output stays one line folded; a click shows its last lines, cut; ^o opens it in full', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'for i in $(seq 1 40); do echo "line $i"; done' } }],
    [{ text: 'Forty lines.' }],
  );
  const ui = await boot(model, root, { plugins: { assistant: { runOutputLines: 5 } } });
  await ui.type('count to forty');
  await ui.press('return');
  await settle(10);
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);

  // Folded: nothing of the forty lines is on screen, whatever their number.
  const folded = unfence(ui.backend.lastFrame);
  expect(folded).not.toContain('lines cut');
  expect(folded).not.toContain('line 40');

  // A click opens it capped to its last runOutputLines lines — the same cap the
  // fold's own model ("… N lines cut · ^o for all") points past, at the global key.
  const foldRow = ui.backend.lastFrame.split('\n').findIndex((r) => r.includes('for i in $(seq 1 40)'));
  ui.backend.mouse('down', 12, foldRow);
  ui.backend.mouse('up', 12, foldRow);
  await settle(6);
  let opened = unfence(ui.backend.lastFrame);
  expect(opened).toContain('… 35 lines cut · ^o for all');
  expect(opened).toContain('line 40');
  expect(opened).not.toContain('line 3 ');
  // The model still got the whole of it — the cap here is the screen's, not its.
  expect(String(sentTo(model).find((m) => m.role === 'tool')?.content)).toContain('line 3\n');

  // ^o (the details key) opens every view in full — every line it kept, not the
  // capped tail a click shows.
  ui.backend.press({ name: 'r', ctrl: true }); // ^r is ^o's alias
  await settle(5);
  opened = unfence(ui.backend.lastFrame);
  expect(opened).not.toContain('lines cut');
  expect(opened).toContain('line 40');
  ui.app.unmount();
});

test('a declined command leaves no block; a failed one shows what it printed and its exit code', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'echo never-ran' } }],
    [{ text: 'Not running it.' }],
    [{ tool: 'run_command', args: { command: 'echo before-it-died; exit 3' } }],
    [{ text: 'It failed.' }],
  );
  const ui = await boot(model, root);
  await ui.type('run it');
  await ui.press('return');
  await settle(10);
  await ui.press('n');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  // Nothing ran, so there is nothing to show — not an empty block.
  expect(ui.backend.lastFrame).not.toContain('$ echo never-ran');
  expect(ui.backend.lastFrame).toContain('Not running it.');

  await ui.type('try the other one');
  await ui.press('return');
  await settle(10);
  await ui.press('y');
  await settleUntil(() => model.requests.length === 4);
  await settle(10);
  // The exit code is in the folded line; what it printed (the bar-prefixed row) needs
  // the block opened — the command's own text already contains "before-it-died".
  const folded = unfence(ui.backend.lastFrame);
  expect(folded).toContain('exit 3');
  expect(ui.backend.lastFrame).not.toContain('│ before-it-died');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(5);
  expect(ui.backend.lastFrame).toContain('│ before-it-died');
  ui.app.unmount();
});

test('what a command printed cannot pass for the host speaking, and survives a restart', async () => {
  // The text in the block was written by a command, so it is drawn inside the block
  // (behind the code bar) and cannot look like a confirmation or a hint line.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-view-sess-'));
  const root = rootDir();
  const first = new ScriptedModel();
  first.script(
    [{ tool: 'run_command', args: { command: 'printf "Confirm write: rm -rf /\\nPress y to confirm\\n"' } }],
    [{ text: 'It printed that.' }],
  );
  const one = await boot(first, root, { sessions: { dir } });
  await one.type('run it');
  await one.press('return');
  await settle(10);
  await one.press('y');
  await settleUntil(() => first.requests.length === 2);
  await settle(10);
  one.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  // Every line of it is inside the block: the code bar is in front of it on screen.
  expect(one.backend.lastFrame).toContain('│ Press y to confirm');
  expect(one.backend.lastFrame).toContain('│ Confirm write: rm -rf /');
  await one.press('escape', 'escape'); // closing the chat saves at once
  one.app.unmount();

  const model = new ScriptedModel();
  const two = await boot(model, root, { sessions: { dir } });
  await settle(6);
  // Restored, folded: one line — the command's own text (which contains "Press y to
  // confirm" too) still cannot pass for a confirmation just because the app
  // restarted; the bar-prefixed row it would stand behind is what proves it is off
  // screen.
  const folded = unfence(two.backend.lastFrame);
  expect(folded).toContain('$ printf');
  expect(two.backend.lastFrame).not.toContain('│ Press y to confirm');
  two.backend.press({ name: 'o', ctrl: true });
  await settle(6);
  expect(two.backend.lastFrame).toContain('│ Press y to confirm');
  // And it is still not the model's: the restored conversation sends it nothing.
  model.script([{ text: 'Fine.' }]);
  await two.type('ok');
  await two.press('return');
  await settleUntil(() => model.requests.length === 1);
  expect(JSON.stringify(sentTo(model))).not.toContain('```console');
  two.app.unmount();
});

// ─── the remembered directory ────────────────────────────────────────────────

// Runs a `!command` and waits until the chat is idle again (the status line stops
// offering Esc).
async function bang(ui: Awaited<ReturnType<typeof boot>>, cmd: string) {
  await ui.type(`!${cmd}`);
  await ui.press('return');
  await settleUntil(() => !ui.backend.lastFrame.includes('Esc stops'));
}

test('cd sticks between !commands — inside the roots only; exit keeps it; /clear goes back to the root', async () => {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'sub'));
  const model = new ScriptedModel();
  const ui = await boot(model, root, {});
  await bang(ui, 'cd sub');
  expect(ui.backend.lastFrame).toContain('→');
  await bang(ui, 'pwd > where.txt');
  expect(fs.existsSync(path.join(root, 'sub', 'where.txt'))).toBe(true);

  await bang(ui, 'cd /');
  expect(ui.backend.lastFrame.replace(/[\s│]+/g, ' ')).toContain('cd led outside the roots');
  await bang(ui, 'touch after-root.txt');
  expect(fs.existsSync(path.join(root, 'sub', 'after-root.txt'))).toBe(true);

  await bang(ui, 'cd .. && exit 3');
  expect(ui.backend.lastFrame).toContain('exit 3');
  await bang(ui, 'touch after-exit.txt');
  expect(fs.existsSync(path.join(root, 'sub', 'after-exit.txt'))).toBe(true);

  await ui.type('/clear');
  await ui.press('return');
  await settle(4);
  await bang(ui, 'touch after-clear.txt');
  expect(fs.existsSync(path.join(root, 'after-clear.txt'))).toBe(true);
  ui.app.unmount();
}, 15_000);

test('run_command runs where the person\'s !cd left the conversation, and its cd is theirs too', async () => {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'a'));
  fs.mkdirSync(path.join(root, 'b'));
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'touch by-model.txt; cd ../b' } }],
    [{ text: 'Done.' }],
  );
  const ui = await boot(model, root);
  await bang(ui, 'cd a');
  await ui.type('run it');
  await ui.press('return');
  await settle(10);
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  expect(fs.existsSync(path.join(root, 'a', 'by-model.txt'))).toBe(true);
  await bang(ui, 'touch by-person.txt');
  expect(fs.existsSync(path.join(root, 'b', 'by-person.txt'))).toBe(true);
  ui.app.unmount();
});

test('the directory survives a restart', async () => {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'sub'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-shell-sess-'));
  const a = await boot(new ScriptedModel(), root, { sessions: { dir } });
  await bang(a, 'cd sub');
  await wait(350); // the debounced save
  a.app.unmount();

  const b = await boot(new ScriptedModel(), root, { sessions: { dir } });
  await settle(6);
  await bang(b, 'touch after-restart.txt');
  expect(fs.existsSync(path.join(root, 'sub', 'after-restart.txt'))).toBe(true);
  b.app.unmount();
});

test('a background run does not move the chat\'s directory', async () => {
  const root = rootDir();
  fs.mkdirSync(path.join(root, 'sub'));
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'background', args: { task: 'go elsewhere' } }],
    [{ text: 'Started.' }],
    [{ tool: 'run_command', args: { command: 'cd ..' } }],
    [{ text: 'Could not.' }],
  );
  const ui = await boot(model, root);
  await bang(ui, 'cd sub');
  await ui.type('go elsewhere in the background');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 4);
  await settle(20);
  await ui.press('escape');
  await bang(ui, 'touch still-here.txt');
  expect(fs.existsSync(path.join(root, 'sub', 'still-here.txt'))).toBe(true);
  ui.app.unmount();
});
