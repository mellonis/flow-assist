// The session picker, end to end: what it lists, what typing finds, what a switch saves
// and loads — for the model too, not only the screen — and what it refuses.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { acquireLock, lockPath } from '../assistant/sessions';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-picker-e2e-'));
const flat = (s: string) => s.replace(/[\s│╭╮╰╯─]+/g, '');
type Sent = { role: string; content: unknown }[];
const sentTo = (m: ScriptedModel) => m.requests.at(-1)!.messages as Sent;
// The session file whose conversation holds `text`.
const fileWith = (dir: string, text: string) => fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
  .map((n) => ({ n, s: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) }))
  .find(({ s }) => s.messages.some((m: { content: unknown }) => m.content === text));
const rowOf = (frame: string, text: string) => frame.split('\n').find((r) => r.includes(text)) ?? '';

async function boot(dir: string, ...answers: string[]) {
  const model = new ScriptedModel();
  model.script(...answers.map((text) => [{ text }]));
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  const ask = async (q: string) => { await ui.type(q); await ui.press('return'); await settle(20); };
  const command = async (c: string) => { await ui.type(c); await ui.press('return'); await settle(4); };
  const chord = async (name: string) => { ui.backend.press({ name, ctrl: true }); await settle(); };
  return { ui, model, ask, command, chord };
}

test('the picker lists every session with its title, newest first, and marks the one another process holds — which it will neither open nor delete', async () => {
  const dir = dirOf();
  const first = await boot(dir, 'held-otvet');
  await first.ui.press('F');
  await first.ask('held-vopros');
  await first.ui.press('escape', 'escape'); // written and locked; the process stays alive

  const second = await boot(dir, 'own-otvet');
  await settle(6);
  await second.ui.press('F');
  await second.ask('own-vopros');
  await second.chord('s');
  let frame = second.ui.backend.lastFrame!;
  expect(frame).toContain('Sessions · 2');
  const rows = frame.split('\n');
  expect(rows.findIndex((r) => r.includes('own-vopros'))).toBeLessThan(rows.findIndex((r) => r.includes('held-vopros')));
  expect(rowOf(frame, 'own-vopros')).toContain('this chat');
  expect(rowOf(frame, 'held-vopros')).toContain('in use elsewhere');

  await second.ui.press('down');
  await second.chord('x');
  frame = second.ui.backend.lastFrame!;
  expect(flat(frame)).toContain(flat('"held-vopros" is open in another flow-assist process — it cannot be deleted'));
  expect(fileWith(dir, 'held-vopros')).toBeDefined();
  await second.ui.press('return');
  frame = second.ui.backend.lastFrame!;
  expect(flat(frame)).toContain(flat('it cannot be opened here'));
  await second.ui.press('escape');
  expect(second.ui.backend.lastFrame).not.toContain('held-otvet');
  second.ui.app.unmount();
  first.ui.app.unmount();
});

test('typing a word from the conversation finds its session; /sessions and the key from the start screen both open the picker', async () => {
  const dir = dirOf();
  const t = await boot(dir, 'the answer mentions zebrafish', 'beta answer');
  await t.ui.press('F');
  await t.ask('alpha question');
  await t.command('/new');
  await t.ask('beta question');
  await t.ui.press('escape', 'escape'); // the chat closed: the start screen has the keys
  await t.chord('s');
  expect(t.ui.backend.lastFrame).toContain('Sessions · 2');
  await t.ui.type('Zebra');
  let frame = t.ui.backend.lastFrame!;
  expect(frame).toContain('Sessions · 1 of 2');
  expect(frame).toContain('alpha question');
  expect(frame).not.toContain('beta question');
  await t.ui.press('escape'); // clears the filter
  expect(t.ui.backend.lastFrame).toContain('Sessions · 2');
  await t.ui.press('escape'); // closes the picker
  frame = t.ui.backend.lastFrame!;
  expect(frame).not.toContain('Sessions ·');
  expect(frame).toContain('beta answer');
  await t.command('/sessions');
  expect(t.ui.backend.lastFrame).toContain('Sessions · 2');
  t.ui.app.unmount();
});

test('opening a session from the picker saves the one being left and loads the chosen one — what the model is sent included', async () => {
  const dir = dirOf();
  const t = await boot(dir, 'first answer', 'second answer', 'back again');
  await t.ui.press('F');
  await t.ask('first question');
  await t.command('/new');
  await t.ask('second question');
  // The answer's debounced save has run by now; typing schedules none, so only a save
  // made by the switch itself can put the draft in the file.
  await new Promise((r) => setTimeout(r, 300));
  await t.ui.type('unsent draft');
  await t.chord('s');
  await t.ui.press('down', 'return');
  await settle(4);
  const frame = t.ui.backend.lastFrame!;
  expect(frame).not.toContain('Sessions ·');
  expect(frame).toContain('first answer');
  expect(frame).not.toContain('second answer');

  const left = fileWith(dir, 'second question')!;
  expect(left.s.messages.some((m: { content: unknown }) => m.content === 'second answer')).toBe(true);
  expect(left.s.draft).toBe('unsent draft');
  expect(fs.existsSync(path.join(dir, left.n.replace(/\.json$/, '.lock')))).toBe(false); // its lock went with it

  await t.ask('and more');
  const sent = sentTo(t.model);
  expect(sent.some((m) => m.role === 'user' && m.content === 'first question')).toBe(true);
  expect(sent.some((m) => m.content === 'second question')).toBe(false);
  expect(sent.at(-1)).toMatchObject({ role: 'user', content: 'and more' });
  t.ui.app.unmount();
});

test('delete asks y/n and removes an idle session and nothing else; this chat’s own is refused', async () => {
  const dir = dirOf();
  const t = await boot(dir, 'doomed answer', 'kept answer');
  await t.ui.press('F');
  await t.ask('doomed question');
  await t.command('/new');
  await t.ask('kept question');
  await t.chord('s');
  await t.chord('x'); // the cursor is on this chat's own session
  expect(flat(t.ui.backend.lastFrame!)).toContain(flat('"kept question" is the session in this chat'));
  await t.ui.press('down');
  await t.chord('x');
  expect(t.ui.backend.lastFrame).toContain('Delete «doomed question»? y deletes it for good · n keeps it');
  await t.ui.press('n');
  expect(t.ui.backend.lastFrame).toContain('Sessions · 2');
  expect(fileWith(dir, 'doomed question')).toBeDefined();
  await t.chord('x');
  await t.ui.press('y');
  const frame = t.ui.backend.lastFrame!;
  expect(frame).toContain('Deleted «doomed question»');
  expect(frame).toContain('Sessions · 1');
  expect(fileWith(dir, 'doomed question')).toBeUndefined();
  expect(fs.readdirSync(dir).filter((n) => n.endsWith('.lock'))).toHaveLength(1); // this chat's own, only
  expect(fileWith(dir, 'kept question')).toBeDefined();
  t.ui.app.unmount();
});

test('rename from the picker writes the title into the file, this chat’s own included; ^n starts a new session and keeps the old one open', async () => {
  const dir = dirOf();
  const t = await boot(dir, 'naming answer', 'other answer');
  await t.ui.press('F');
  await t.ask('naming question');
  await t.command('/new');
  await t.ask('other question');
  await t.chord('s');
  const before = fileWith(dir, 'naming question')!.s.updatedAt;
  await t.ui.press('down');
  await t.chord('r');
  await t.chord('u'); // the field starts with the title; ^u empties it
  await t.ui.type('Renamed by hand');
  await t.ui.press('return');
  expect(t.ui.backend.lastFrame).toContain('Renamed by hand');
  const renamed = fileWith(dir, 'naming question')!.s;
  expect(renamed.title).toBe('Renamed by hand');
  expect(renamed.updatedAt).toBe(before);

  await t.ui.press('up');
  await t.chord('r');
  await t.chord('u');
  await t.ui.type('Mine now');
  await t.ui.press('return');
  expect(fileWith(dir, 'other question')!.s.title).toBe('Mine now');

  await t.chord('n');
  const frame = t.ui.backend.lastFrame!;
  expect(frame).not.toContain('Sessions ·');
  expect(frame).not.toContain('other answer');
  expect(fileWith(dir, 'other question')!.s.closed).not.toBe(true);
  t.ui.app.unmount();
});

test('a question that arrives while the picker is up is drawn over it and answered first; the picker comes back', async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  model.script(
    [{ hold: true }, { tool: 'ask_user', args: { questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }] } }],
    [{ text: 'fine' }],
  );
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await ui.press('F');
  await ui.type('pick one');
  await ui.press('return');
  await settle(4); // the turn is running, held
  ui.backend.press({ name: 's', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).toContain('Sessions ·');
  model.release();
  await settle(20);
  expect(ui.backend.lastFrame).toContain('Which one?');
  expect(ui.backend.lastFrame).not.toContain('Sessions ·');
  await ui.press('escape'); // dismisses the question, not the picker
  await settle(20);
  expect(ui.backend.lastFrame).toContain('Sessions ·');
  ui.app.unmount();
});

test('a write’s y/n that arrives while the picker is up is drawn over it and answered first — `n` declines, it is not typed into the filter', async () => {
  const dir = dirOf();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-picker-yn-')));
  const model = new ScriptedModel();
  model.script([{ hold: true }, { tool: 'run_command', args: { command: 'echo hi' } }], [{ text: 'declined, fine' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir }, shell: { roots: [root] } });
  await ui.press('F');
  await ui.type('run it');
  await ui.press('return');
  await settle(4); // the turn is running, held
  ui.backend.press({ name: 's', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).toContain('Sessions ·');
  model.release();
  for (let i = 0; i < 100 && !ui.backend.lastFrame!.includes('echo hi'); i++) await settle(2);
  expect(ui.backend.lastFrame).toContain('echo hi');
  expect(ui.backend.lastFrame).not.toContain('Sessions ·');
  await ui.press('n'); // declines the write
  await settle(20);
  const frame = ui.backend.lastFrame!;
  expect(frame).toContain('Sessions ·');
  expect(rowOf(frame, 'filter ›')).toMatch(/filter ›\s*│/);
  ui.app.unmount();
});

test('an error the chat showed before the picker opened does not hide the picker’s own notice', async () => {
  const dir = dirOf();
  const t = await boot(dir, 'only answer');
  await t.ui.press('F');
  await t.ask('only question');
  await t.command('/resume 99');
  expect(t.ui.backend.lastFrame).toContain('/resume takes a number');
  await t.chord('s');
  expect(t.ui.backend.lastFrame).not.toContain('/resume takes a number');
  await t.chord('x'); // this chat's own session: refused, and the notice says why
  expect(flat(t.ui.backend.lastFrame!)).toContain(flat('"only question" is the session in this chat'));
  t.ui.app.unmount();
});

// A command the model ran, confirmed, then the answer — a block with a fold line to click.
const upAt = async (ui: Awaited<ReturnType<typeof bootApp>>, text: string) => {
  for (let i = 0; i < 200 && !ui.backend.lastFrame!.includes(text); i++) await settle(1);
};
const clickRow = async (ui: Awaited<ReturnType<typeof bootApp>>, text: string) => {
  const y = ui.backend.lastFrame!.split('\n').findIndex((r) => r.includes(text));
  ui.backend.mouse('down', 12, y);
  ui.backend.mouse('up', 12, y);
  await settle(6);
  return y;
};
const PAGER_HINT = 'the wheel scroll · Esc close';

test('a click over the picker reaches nothing it hides: no pager opens over it, and none is waiting once it closes', async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'seq 1 300' } }], [{ text: 'Done counting.' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir }, shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('count');
  await ui.press('return');
  await upAt(ui, 'Confirm write: run_command');
  await ui.press('y');
  await upAt(ui, 'Done counting.');
  await settle(8);
  const y = ui.backend.lastFrame!.split('\n').findIndex((r) => r.includes('seq 1 300 ·'));
  expect(y).toBeGreaterThan(0);
  ui.backend.press({ name: 's', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).toContain('Sessions ·');
  ui.backend.mouse('down', 12, y); // where the tall block's fold line was
  ui.backend.mouse('up', 12, y);
  await settle(6);
  expect(ui.backend.lastFrame).toContain('Sessions ·');
  expect(ui.backend.lastFrame).not.toContain(PAGER_HINT);
  await ui.press('escape'); // the picker closes: the conversation, not a pager
  expect(ui.backend.lastFrame).not.toContain(PAGER_HINT);
  expect(ui.backend.lastFrame).toContain('Done counting.');
  ui.app.unmount();
});

test('while a y/n is drawn in the picker’s place, a click reaches the conversation it shows', async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'seq 1 5' } }],
    [{ text: 'Done counting.' }],
    [{ hold: true }, { tool: 'run_command', args: { command: 'echo hi' } }],
    [{ text: 'Declined, fine.' }],
  );
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir }, shell: { timeoutMs: 20000 } });
  await ui.press('F');
  await ui.type('count');
  await ui.press('return');
  await upAt(ui, 'Confirm write: run_command');
  await ui.press('y');
  await upAt(ui, 'Done counting.');
  await ui.type('say hi');
  await ui.press('return');
  await settle(4); // held
  ui.backend.press({ name: 's', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).toContain('Sessions ·');
  model.release();
  await upAt(ui, 'Confirm write: run_command');
  expect(ui.backend.lastFrame).not.toContain('Sessions ·');
  expect(ui.backend.lastFrame).not.toContain('│ 5');
  await clickRow(ui, 'seq 1 5 ·'); // opens the fold, as it does with no picker behind
  expect(ui.backend.lastFrame).toContain('│ 5');
  await ui.press('n');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('Sessions ·');
  ui.app.unmount();
});

test('the picker goes with the chat when it closes', async () => {
  const dir = dirOf();
  const t = await boot(dir, 'an answer');
  await t.ui.press('F');
  await t.ask('a question');
  await t.chord('s');
  expect(t.ui.backend.lastFrame).toContain('Sessions ·');
  t.ui.backend.press({ name: ']', ctrl: true }); // Ctrl+] closes the chat, whatever holds its keys
  await settle();
  expect(t.ui.backend.lastFrame).not.toContain('Sessions ·');
  t.ui.backend.press({ name: ']', ctrl: true }); // and opens it again
  await settle();
  expect(t.ui.backend.lastFrame).not.toContain('Sessions ·');
  expect(t.ui.backend.lastFrame).toContain('an answer');
  t.ui.app.unmount();
});

test('a session taken by another process after the list was read: ⏎ is refused and the picker stays; a rename of one whose file is gone says so', async () => {
  const dir = dirOf();
  const t = await boot(dir, 'taken answer', 'mine answer');
  await t.ui.press('F');
  await t.ask('taken question');
  await t.command('/new');
  await t.ask('mine question');
  await t.chord('s');
  const taken = fileWith(dir, 'taken question')!.n.replace(/\.json$/, '');
  expect(acquireLock(dir, taken, 'another-process').status).toBe('acquired'); // this pid, alive: held
  await t.ui.press('down', 'return');
  let frame = t.ui.backend.lastFrame!;
  expect(frame).toContain('Sessions · 2');
  expect(flat(frame)).toContain(flat('"taken question" is open in another flow-assist process — it cannot be opened here'));
  expect(rowOf(frame, 'taken question')).toContain('in use elsewhere');
  expect(frame).not.toContain('taken answer');

  fs.rmSync(lockPath(dir, taken)); // let go; the picker opened again reads it free
  await t.ui.press('escape');
  await t.chord('s');
  await t.ui.press('down');
  fs.rmSync(path.join(dir, `${taken}.json`)); // and then its file goes
  await t.chord('r');
  await t.chord('u');
  await t.ui.type('Too late');
  await t.ui.press('return');
  frame = t.ui.backend.lastFrame!;
  expect(flat(frame)).toContain(flat('"taken question" is gone — its file was removed'));
  expect(frame).not.toContain('Renamed to');
  t.ui.app.unmount();
});
