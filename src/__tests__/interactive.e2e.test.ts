// `!!command` through the real chat: the terminal handed over (the test backend's
// suspension observed), the program's recording cleaned and shown as its console view,
// joined to the model's history, and a turn started at once with the host's ask.
//
// The test backend has no terminal, so `script` is stood in for: the fake takes the
// BSD argv the runner builds (`script -q <file> /bin/sh -c <command>`), runs the
// command for real with a line on its input — the name a person would type at the
// prompt — and writes what it printed into the recording file with the terminal's
// `\r\n`, as the real one does. The temp files and the cleaning are the real code.
import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InteractiveDeps, InteractiveSpawn } from '../assistant/interactive';
import { INTERACTIVE_ASK } from '../assistant/interactive';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rootDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-tty-e2e-')));
type Sent = { role: string; content: unknown }[];
const settleUntil = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};

// A small interactive program: asks for a name, greets in colour, draws a progress
// line with carriage returns, prints an error in red and exits 1.
const PROGRAM = [
  '#!/bin/sh',
  "printf 'Your name? '",
  'read name',
  `printf '\\033[1;32mHello, %s!\\033[0m\\n' "$name"`,
  `for p in 10 50 100; do printf '\\rprogress %3s%%' "$p"; done`,
  "printf '\\n'",
  `printf '\\033[31merror: one file skipped\\033[0m\\n'`,
  'exit 1',
].join('\n');

interface Seen { suspendedWhileRunning: boolean[]; recordings: string[]; argv: string[][] }
function fakeScript(seen: Seen, backend: () => { suspended: boolean }): InteractiveSpawn {
  return async (file, args, { cwd }) => {
    seen.argv.push([file, ...args]);
    seen.suspendedWhileRunning.push(backend().suspended);
    const rec = args[1]!;
    seen.recordings.push(rec);
    const p = Bun.spawn([args[2]!, ...args.slice(3)], { cwd, stdin: new TextEncoder().encode('Ruslan\n'), stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    fs.writeFileSync(rec, `^D\b\b${out.replace(/\n/g, '\r\n')}`);
    return { code, signal: null };
  };
}

async function boot(model: ScriptedModel, root: string, deps: (backend: () => { suspended: boolean }) => InteractiveDeps, cols = 110) {
  let ui: Awaited<ReturnType<typeof bootApp>> | null = null;
  const backend = () => ui!.backend;
  ui = await bootApp(model, cols, 32, undefined, { shell: { roots: [root] } }, { interactive: deps(backend) });
  await ui.press('F');
  return ui;
}

const newSeen = (): Seen => ({ suspendedWhileRunning: [], recordings: [], argv: [] });

test('!!command hands the terminal over, shows the cleaned recording as its view, and asks the model to look at it', async () => {
  const root = rootDir();
  fs.writeFileSync(path.join(root, 'greet.sh'), PROGRAM, { mode: 0o755 });
  const model = new ScriptedModel();
  model.script([{ text: 'It greeted Ruslan and skipped one file.' }]);
  const seen = newSeen();
  const ui = await boot(model, root, (b) => ({ detect: () => 'bsd', spawn: fakeScript(seen, b), signals: new EventEmitter() }));

  await ui.type('!!./greet.sh');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1 && ui.backend.lastFrame.includes('It greeted Ruslan'));

  // The terminal was the program's while it ran, and the chat has it back.
  expect(ui.backend.suspensions).toBe(1);
  expect(seen.suspendedWhileRunning).toEqual([true]);
  expect(ui.backend.suspended).toBe(false);
  // The program ran under `script`, through the shell `!` uses, in the first root.
  expect(seen.argv[0]!.slice(0, 5)).toEqual(['script', '-q', seen.recordings[0]!, '/bin/sh', '-c']);
  expect(seen.argv[0]![5]!.startsWith('./greet.sh\n')).toBe(true);
  // The recording's temp files are gone.
  expect(fs.existsSync(path.dirname(seen.recordings[0]!))).toBe(false);

  const frame = ui.backend.lastFrame;
  expect(frame).toMatch(/\$ \.\/greet\.sh · interactive · ✗ exit 1 · \d+\.\d s/);
  // The host's ask is on screen as a message of the person's side — and it is the
  // host's words, drawn dim, not the person's.
  expect(frame).toContain(INTERACTIVE_ASK.slice(0, 40));

  // What the model was SENT: the recording, cleaned, as the person's shell message,
  // and then the ask — the last message of the request.
  const sent = model.requests[0]!.messages as Sent;
  const shell = sent.find((m) => m.role === 'user' && String(m.content).startsWith('The person ran an interactive program'));
  expect(shell).toBeDefined();
  const body = String(shell!.content);
  expect(body).toContain(`in ${root}`);
  expect(body).toContain('$ ./greet.sh');
  expect(body).toContain('(exit 1 ·');
  expect(body.split('\n')).toContain('Your name? Hello, Ruslan!');
  expect(body.split('\n')).toContain('progress 100%');
  expect(body.split('\n')).toContain('error: one file skipped');
  expect(body).not.toContain('\u001b');
  expect(body).not.toContain('\r');
  expect(body).not.toContain('progress  10%');
  expect(body).not.toContain('^D');
  const last = sent.at(-1)!;
  expect(last.role).toBe('user');
  expect(String(last.content)).toContain(INTERACTIVE_ASK);
  expect(sent.indexOf(shell!)).toBeLessThan(sent.length - 1);

  // A click opens the block to the recording's lines.
  const row = frame.split('\n').findIndex((r) => r.includes('./greet.sh · interactive'));
  ui.backend.mouse('down', 12, row);
  ui.backend.mouse('up', 12, row);
  await settle(6);
  expect(ui.backend.lastFrame).toContain('│ progress 100%');
  expect(ui.backend.lastFrame).toContain('│ Your name? Hello, Ruslan!');

  // ↑ brings back `!!./greet.sh` — not the ask — shown in shell mode as `!./greet.sh`.
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('! !./greet.sh');
  ui.app.unmount();
});

test('the ask is drawn as the host speaking: a dim marker and dim text', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script([{ text: 'Fine.' }]);
  const seen = newSeen();
  const ui = await boot(model, root, (b) => ({ detect: () => 'bsd', spawn: fakeScript(seen, b), signals: new EventEmitter() }));
  await ui.type('!!echo hi');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Fine.'));
  const lines = ui.backend.lastFrame.split('\n');
  const y = lines.findIndex((l) => l.includes(INTERACTIVE_ASK.slice(0, 30)));
  expect(y).toBeGreaterThan(-1);
  const buf = ui.backend.lastBuffer!;
  const x = lines[y]!.indexOf('Look at');
  expect(buf.get(x, y)?.style.dim).toBe(true);
  expect(buf.get(lines[y]!.indexOf('› '), y)?.style.dim).toBe(true);
  ui.app.unmount();
});

test('shell mode: a leading ! runs the line interactively; ↑ then ⏎ runs it the same way again', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script([{ text: 'First.' }], [{ text: 'Second.' }]);
  const seen = newSeen();
  const ui = await boot(model, root, (b) => ({ detect: () => 'bsd', spawn: fakeScript(seen, b), signals: new EventEmitter() }));
  await ui.type('!'); // shell mode
  await ui.type('!echo hi');
  expect(ui.backend.lastFrame).toContain('! !echo hi');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('First.'));
  expect(ui.backend.suspensions).toBe(1);
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('! !echo hi');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Second.'));
  expect(ui.backend.suspensions).toBe(2);
  expect(model.requests).toHaveLength(2);
  ui.app.unmount();
});

test('plain !command still hands nothing over and starts no turn', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  const seen = newSeen();
  const ui = await boot(model, root, (b) => ({ detect: () => 'bsd', spawn: fakeScript(seen, b), signals: new EventEmitter() }));
  await ui.type('!echo plain');
  await ui.press('return');
  await settleUntil(() => /echo plain · ✓/.test(ui.backend.lastFrame));
  await settle(10);
  expect(ui.backend.suspensions).toBe(0);
  expect(seen.argv).toHaveLength(0);
  expect(model.requests).toHaveLength(0);
  expect(ui.backend.lastFrame).not.toContain('interactive');
  ui.app.unmount();
});

test('no `script` on PATH: the program still gets the terminal, a note says nothing was recorded, and no turn starts', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  const calls: string[][] = [];
  const ui = await boot(model, root, (b) => ({
    detect: () => null,
    spawn: async (file, args) => { calls.push([file, ...args, String(b().suspended)]); return { code: 0, signal: null }; },
    signals: new EventEmitter(),
  }));
  await ui.type('!!vim notes.md');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('nothing was recorded'));
  await settle(10);
  expect(ui.backend.suspensions).toBe(1);
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBe('/bin/sh');
  expect(calls[0]!.at(-1)).toBe('true'); // the terminal was handed over while it ran
  expect(ui.backend.lastFrame).toContain('No script on PATH');
  expect(ui.backend.lastFrame).toMatch(/vim notes\.md · interactive · ✓/);
  expect(model.requests).toHaveLength(0);
  ui.app.unmount();
});

test('a program that cannot run: its temp files go, the error is said, and no turn starts', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  let dir = '';
  const ui = await boot(model, root, () => ({
    detect: () => 'bsd',
    spawn: async (_f, args) => { dir = path.dirname(args[1]!); fs.writeFileSync(args[1]!, 'half'); throw new Error('the terminal went away'); },
    signals: new EventEmitter(),
  }));
  await ui.type('!!top');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('the terminal went away'));
  await settle(10);
  expect(dir).not.toBe('');
  expect(fs.existsSync(dir)).toBe(false);
  expect(model.requests).toHaveLength(0);
  ui.app.unmount();
});

test('a cd outside the roots is not remembered, as with !', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script([{ text: 'Seen.' }], [{ text: 'ok' }]);
  const seen = newSeen();
  const ui = await boot(model, root, (b) => ({ detect: () => 'bsd', spawn: fakeScript(seen, b), signals: new EventEmitter() }), root.length + 70);
  await ui.type('!!cd / && echo moved');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Seen.'));
  const sent = model.requests[0]!.messages as Sent;
  expect(String(sent.find((m) => String(m.content).startsWith('The person ran an interactive program'))!.content)).toContain('cd led outside the roots');
  // The next command still runs in the root.
  await ui.type('!!pwd');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 2);
  const second = model.requests[1]!.messages as Sent;
  const pwdMsg = second.filter((m) => String(m.content).startsWith('The person ran an interactive program')).at(-1)!;
  expect(String(pwdMsg.content).split('\n')).toContain(root);
  ui.app.unmount();
});

test('!!command while an answer is coming is refused like !, hands nothing over and queues nothing', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script([{ text: 'Thinking' }, { hold: true }, { text: ' done.' }]);
  const seen = newSeen();
  const ui = await boot(model, root, (b) => ({ detect: () => 'bsd', spawn: fakeScript(seen, b), signals: new EventEmitter() }));
  await ui.type('a question');
  await ui.press('return');
  await settle(10);
  await ui.type('!!echo later');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('still running');
  expect(ui.backend.lastFrame).not.toContain('queued');
  expect(ui.backend.suspensions).toBe(0);
  model.release();
  await settle(20);
  await wait(50);
  expect(seen.argv).toHaveLength(0);
  expect(model.requests).toHaveLength(1);
  ui.app.unmount();
});

test('a message typed while the ask is being answered queues behind it, and Esc gives it back to the field', async () => {
  const root = rootDir();
  const model = new ScriptedModel();
  model.script([{ text: 'Looking' }, { hold: true }, { text: ' at it.' }]);
  const seen = newSeen();
  const ui = await boot(model, root, (b) => ({ detect: () => 'bsd', spawn: fakeScript(seen, b), signals: new EventEmitter() }));
  await ui.type('!!echo hi');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  await settle(10);
  await ui.type('and then?');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('queued');
  await ui.press('escape');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('› and then?');
  expect(model.requests).toHaveLength(1);
  ui.app.unmount();
});
