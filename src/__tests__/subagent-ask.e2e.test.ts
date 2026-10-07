// A subagent's y/n in the view of the conversation that started it (AGENTS.md (subagent
// y/n)): drawn in the field's place or as a notice above the field, answered by `y` / `n`
// alone, on an empty field, after a pause. The real app on the scripted model; the pause
// is read from `askClock`, which the tests move instead of sleeping.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askClock } from '../assistant/child-ask-guard.ts';
import { listTree } from './helpers/session-files';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
const realNow = askClock.now;
const clock = { t: 10_000 };
afterEach(() => { globalThis.fetch = realFetch; askClock.now = realNow; });

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const rowsOf = (ui: UI) => frameOf(ui).split('\n');
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
const BLOCK = 'Confirm write: run_command';
const NOTICE = 'waits for a y/n — clear the line to answer';
// After the pause: an answer counts.
const pause = () => { clock.t += 700; };

function dirs() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-subask-')));
  return { root, sessions: fs.mkdtempSync(path.join(os.tmpdir(), 'fa-subask-s-')) };
}
const touch = (root: string, name: string) => [{ tool: 'run_command', args: { command: `touch ${path.join(root, name)}` } }];

// A booted chat; one scripted child for each mark, each asking for one write and then
// saying what came of it.
async function boot(marks: string[], opts: { cols?: number; rows?: number; mode?: 'window' | 'panel'; guest?: (make: never) => never; hold?: boolean; toastMs?: number; autoRun?: boolean } = {}) {
  clock.t = 10_000;
  askClock.now = () => clock.t;
  const d = dirs();
  const model = new ScriptedModel();
  const children = marks.map((mark) => {
    const child = model.when((req) => firstUser(req).includes(mark));
    const file = `${mark}.txt`;
    child.script(...(opts.hold ? [[{ hold: true }, ...touch(d.root, file)]] : [touch(d.root, file)]), [{ text: `${mark} settled` }]);
    return { child, file: path.join(d.root, file) };
  });
  const ui = await bootApp(model, opts.cols ?? 140, opts.rows ?? 34, opts.guest as never, { sessions: { dir: d.sessions }, shell: { roots: [d.root], ...(opts.autoRun ? { autoRun: true } : {}) }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: opts.toastMs ?? 10_000, ...(opts.mode ? { chatMode: opts.mode } : {}) });
  await ui.press('F');
  return { ...d, model, children, ui };
}
const fieldRow = (ui: UI) => rowsOf(ui).findLast((r) => r.includes('› ')) ?? '';

test('a write in a subagent draws a labelled block in the chat; y runs it and the finish row lands', async () => {
  const { children: [a], ui } = await boot(['LBL-ONE']);
  await ask(ui, '/subagent LBL-ONE do it');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  const title = rowsOf(ui).find((r) => r.includes(BLOCK))!;
  expect(title).toContain('⚠ lbl-one-do · Confirm write: run_command');
  expect(frameOf(ui)).toContain('y yes · n no');
  expect(frameOf(ui)).not.toContain('Press y to confirm');
  expect(fs.existsSync(a!.file)).toBe(false);
  pause();
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('◆ lbl-one-do finished:'));
  expect(fs.existsSync(a!.file)).toBe(true);
  expect(frameOf(ui)).toContain('LBL-ONE settled');
  expect(frameOf(ui)).not.toContain(BLOCK);
  ui.app.unmount();
});

test('n declines the write; the subagent goes on and finishes', async () => {
  const { children: [a], ui } = await boot(['NO-ONE']);
  await ask(ui, '/subagent NO-ONE do it');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  pause();
  await ui.press('n');
  await settleUntil(() => frameOf(ui).includes('◆ no-one-do finished:'));
  expect(fs.existsSync(a!.file)).toBe(false);
  expect(frameOf(ui)).not.toContain(BLOCK);
  ui.app.unmount();
});

test('with a draft, y types a letter and the notice stands above the field; after clearing the line y answers', async () => {
  const { children: [a], ui } = await boot(['DRAFT-ONE']);
  await ask(ui, '/subagent DRAFT-ONE do it');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  pause();
  await ui.press('h'); // not an answer: it types, and the block gives the place back
  await settleUntil(() => frameOf(ui).includes(NOTICE));
  expect(frameOf(ui)).not.toContain(BLOCK);
  pause();
  await ui.press('y');
  await settle(4);
  expect(fs.existsSync(a!.file)).toBe(false);
  let r = rowsOf(ui);
  const at = r.findIndex((l) => l.includes(NOTICE));
  expect(r[at]).toContain('⏸ draft-one-do waits for a y/n');
  expect(r[at + 1]).toContain('› hy'); // the notice is the row right above the field
  await ui.press('backspace');
  await ui.press('backspace');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  expect(frameOf(ui)).not.toContain(NOTICE);
  pause();
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('◆ draft-one-do finished:'));
  expect(fs.existsSync(a!.file)).toBe(true);
  ui.app.unmount();
});

test('a y at the moment the block appears, or right after another key, does not answer', async () => {
  const { children: [a], ui } = await boot(['ARM-ONE']);
  await ask(ui, '/subagent ARM-ONE do it');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  // No pause since the block came on screen.
  await ui.press('y');
  await settle(4);
  expect(fs.existsSync(a!.file)).toBe(false);
  expect(frameOf(ui)).toContain(NOTICE); // it was typed
  await ui.press('backspace');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  // The block has been there long enough, but the person's key was just now.
  pause();
  await ui.press('h');
  await ui.press('backspace');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  clock.t += 300;
  await ui.press('y');
  await settle(4);
  expect(fs.existsSync(a!.file)).toBe(false);
  await ui.press('backspace');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  pause();
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('◆ arm-one-do finished:'));
  expect(fs.existsSync(a!.file)).toBe(true);
  ui.app.unmount();
});

test('a request that arrives long after the last key is still not answered by a y at once', async () => {
  const { children: [a], ui } = await boot(['LATE-ONE'], { hold: true });
  await ask(ui, '/subagent LATE-ONE do it');
  await settleUntil(() => a!.child.held);
  clock.t += 5000; // the person has not touched a key for a while
  a!.child.release();
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  await ui.press('y');
  await settle(4);
  expect(fs.existsSync(a!.file)).toBe(false);
  expect(frameOf(ui)).toContain(NOTICE); // it was typed
  ui.app.unmount();
});

test('Enter on an empty field does not answer a subagent\'s request; neither does Esc', async () => {
  const { children: [a], ui } = await boot(['KEYS-ONE']);
  await ask(ui, '/subagent KEYS-ONE do it');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  pause();
  await ui.press('return');
  await settle(6);
  expect(frameOf(ui)).toContain(BLOCK);
  expect(fs.existsSync(a!.file)).toBe(false);
  pause();
  await ui.press('escape');
  await settle(6);
  expect(frameOf(ui)).toContain(BLOCK);
  expect(fs.existsSync(a!.file)).toBe(false);
  pause();
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('◆ keys-one-do finished:'));
  expect(fs.existsSync(a!.file)).toBe(true);
  ui.app.unmount();
});

test('two subagents ask: one block at a time, the older first, and the next arms afresh', async () => {
  const { children: [a, b], ui } = await boot(['OLD-ONE', 'NEW-ONE']);
  await ask(ui, '/subagent OLD-ONE first');
  await settleUntil(() => frameOf(ui).includes('⚠ old-one-first ·'));
  pause();
  await ask(ui, '/subagent NEW-ONE second'); // typed beside the block: its keys are the field's
  await settleUntil(() => frameOf(ui).includes('NEW-ONE second') === false && a!.child.requests.length === 1 && b!.child.requests.length === 1);
  await settleUntil(() => frameOf(ui).includes('⚠ old-one-first ·'));
  expect(frameOf(ui)).not.toContain('new-one-second ·');
  pause();
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('⚠ new-one-second ·'));
  expect(fs.existsSync(a!.file)).toBe(true);
  expect(fs.existsSync(b!.file)).toBe(false);
  // Right after an answer the next block is not answerable: this y is a letter.
  await ui.press('y');
  await settle(4);
  expect(fs.existsSync(b!.file)).toBe(false);
  await ui.press('backspace');
  await settleUntil(() => frameOf(ui).includes('⚠ new-one-second ·'));
  pause();
  await ui.press('y');
  await settleUntil(() => fs.existsSync(b!.file));
  ui.app.unmount();
});

test('the conversation\'s own y/n comes first, with today\'s keys; the subagent\'s is offered after it', async () => {
  const { model, children: [a], ui } = await boot(['BOTH-ONE'], { hold: true });
  await ask(ui, '/subagent BOTH-ONE do it');
  await settleUntil(() => a!.child.held);
  model.script([{ tool: 'run_command', args: { command: 'echo mine' } }], [{ text: 'parent done' }]);
  await ask(ui, 'hello');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  a!.child.release();
  await settleUntil(() => a!.child.requests.length >= 1);
  await settle(10);
  // The own block, with its own title and hint.
  expect(frameOf(ui)).toContain('Press y to confirm · n to decline');
  expect(frameOf(ui)).not.toContain('both-one-do ·');
  // Today's keys, at once: ⏎ answers, no pause.
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('⚠ both-one-do ·'));
  expect(frameOf(ui)).toContain('parent done');
  expect(fs.existsSync(a!.file)).toBe(false);
  pause();
  await ui.press('y');
  await settleUntil(() => fs.existsSync(a!.file));
  ui.app.unmount();
});

test('a picker open when the request arrives stays open; the request is there after it closes', async () => {
  const { children: [a], ui } = await boot(['PICK-ONE'], { hold: true });
  await ask(ui, '/subagent PICK-ONE do it');
  await settleUntil(() => a!.child.held);
  await ask(ui, '/sessions');
  await settleUntil(() => frameOf(ui).includes('Sessions ·'));
  a!.child.release();
  await settleUntil(() => a!.child.requests.length >= 1);
  await settle(10);
  expect(frameOf(ui)).toContain('Sessions ·');
  expect(frameOf(ui)).not.toContain(BLOCK);
  pause();
  await ui.press('y'); // goes to the picker's filter, not to the request
  await settle(4);
  expect(fs.existsSync(a!.file)).toBe(false);
  await ui.press('escape'); // clears the filter
  await settle(4);
  expect(frameOf(ui)).toContain('Sessions ·');
  await ui.press('escape');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  expect(frameOf(ui)).not.toContain('Sessions ·');
  pause();
  await ui.press('y');
  await settleUntil(() => fs.existsSync(a!.file));
  ui.app.unmount();
});

// A guest with a screen, so the chat can dock.
const boards = (make: any) => [make('boards', { name: 'boards', keycaps: () => ['c card'], components: { view: (api: any) => function View() { return api.ui.h(api.ui.Text, null, 'BOARD-SURFACE'); } } })];
const COLLAPSE = { name: '\\', ctrl: true };

test('the chat collapsed: the footer says it waits; opened again, the block is there', async () => {
  const { children: [a], ui } = await boot(['FOOT-ONE'], { hold: true, toastMs: 200, cols: 160, rows: 40, mode: 'panel', guest: boards as never });
  await ask(ui, '/subagent FOOT-ONE do it');
  await settleUntil(() => a!.child.held);
  ui.backend.press(COLLAPSE);
  await settle();
  a!.child.release();
  await settleUntil(() => a!.child.requests.length >= 1);
  await settleUntil(() => rowsOf(ui).some((r) => /\? waiting for you/.test(r)));
  expect(rowsOf(ui).some((r) => /\? waiting for you/.test(r))).toBe(true);
  expect(fs.existsSync(a!.file)).toBe(false);
  ui.backend.press(COLLAPSE);
  await settle();
  expect(frameOf(ui)).toContain(BLOCK);
  ui.app.unmount();
});

const chatTop = (ui: UI) => rowsOf(ui).findIndex((l) => l.includes('╭─ ƒ Flow Assist'));

test('a bottom panel grows for the subagent\'s block, and is its own size again once it is answered', async () => {
  const { children: [a], ui } = await boot(['GROW-ONE'], { hold: true, cols: 100, rows: 30, mode: 'panel', guest: boards as never });
  const before = chatTop(ui);
  await ask(ui, '/subagent GROW-ONE do it');
  await settleUntil(() => a!.child.held);
  a!.child.release();
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  expect(chatTop(ui)).toBeLessThan(before);
  pause();
  await ui.press('y');
  await settleUntil(() => fs.existsSync(a!.file));
  await settleUntil(() => chatTop(ui) === before);
  expect(chatTop(ui)).toBe(before);
  ui.app.unmount();
});

test('in a 12-row bottom panel with a draft, the notice line does not squeeze the list out', async () => {
  const { children: [a], ui } = await boot(['TINY-ONE'], { hold: true, cols: 100, rows: 24, mode: 'panel', guest: boards as never });
  await ask(ui, '/subagent TINY-ONE do it');
  await settleUntil(() => a!.child.held);
  await ui.type('draft');
  a!.child.release();
  await settleUntil(() => frameOf(ui).includes(NOTICE));
  await settle(6);
  const r = rowsOf(ui);
  const top = chatTop(ui);
  const noticeAt = r.findIndex((l) => l.includes(NOTICE));
  // The conversation keeps its rows: between the title and the hint row there are at least 4.
  const hintAt = r.findIndex((l) => l.includes('history · wheel'));
  expect(top).toBeGreaterThanOrEqual(0);
  expect(hintAt - top - 1).toBeGreaterThanOrEqual(4);
  expect(noticeAt).toBeGreaterThan(hintAt);
  expect(r.findIndex((l) => l.includes('› draft'))).toBe(noticeAt + 1);
  expect(r.some((l) => l.includes('/subagent TINY-ONE do it'))).toBe(true);
  ui.app.unmount();
});

test('/subagent lists a subagent that waits for the answer as waiting', async () => {
  const { children: [a], ui } = await boot(['LIST-ONE']);
  await ask(ui, '/subagent LIST-ONE do it');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  pause();
  await ask(ui, '/subagent');
  await settleUntil(() => /1 · list-one-do · waiting/.test(frameOf(ui)));
  expect(frameOf(ui)).toMatch(/1 · list-one-do · waiting/);
  expect(fs.existsSync(a!.file)).toBe(false);
  ui.app.unmount();
});

test('the notice line is a row of the field\'s place: a plan that fit whole gives way to one line when it stands', async () => {
  const { model, children: [a], ui } = await boot(['PLAN-ONE'], { hold: true, rows: 18, cols: 100 });
  model.script([{ tool: 'todo', args: { action: 'add', items: ['read the diff', 'run the tests', 'write the summary'] } }], [{ text: 'Planned.' }]);
  await ask(ui, '/subagent PLAN-ONE do it');
  await settleUntil(() => a!.child.held);
  await ask(ui, 'plan it');
  await settleUntil(() => frameOf(ui).includes('Planned.'));
  await ui.type('draft');
  const boxes = () => rowsOf(ui).filter((r) => /[☐⊟☑] /.test(r)).length;
  await settleUntil(() => boxes() === 3);
  expect(boxes()).toBe(3);
  expect(frameOf(ui)).toContain('▾ plan');
  a!.child.release();
  await settleUntil(() => frameOf(ui).includes(NOTICE));
  await settle(6);
  expect(frameOf(ui)).not.toContain('▾ plan');
  expect(boxes()).toBe(1);
  expect(frameOf(ui)).toContain('plan · ');
  ui.app.unmount();
});

test('a bottom panel grows by the notice line when a multi-line draft is in the field', async () => {
  const { children: [a], ui } = await boot(['MULTI-ONE'], { hold: true, cols: 100, rows: 24, mode: 'panel', guest: boards as never });
  await ask(ui, '/subagent MULTI-ONE do it');
  await settleUntil(() => a!.child.held);
  await ui.type('one');
  for (const w of ['two', 'three', 'four']) { ui.backend.press({ name: 'return', shift: true }); await ui.type(w); }
  await settle(6);
  const without = chatTop(ui);
  a!.child.release();
  await settleUntil(() => frameOf(ui).includes(NOTICE));
  await settle(6);
  expect(chatTop(ui)).toBe(without - 1);
  ui.app.unmount();
});

// The confirm lines of the session saved in `dir`.
async function confirms(dir: string): Promise<Record<string, unknown>[]> {
  await settleUntil(() => listTree(dir).some((n) => n.endsWith('.log.jsonl')), 200);
  const file = listTree(dir).find((n) => n.endsWith('.log.jsonl'));
  if (!file) return [];
  return fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.t === 'confirm');
}

test('--auto answers a write by itself, with no block: the journal says by auto under the subagent', async () => {
  const { sessions, children: [a], ui } = await boot(['AUTOY-ONE'], { autoRun: true });
  await ask(ui, '/subagent --auto AUTOY-ONE do it');
  await settleUntil(() => frameOf(ui).includes('◆ autoy-one-do finished:'));
  expect(frameOf(ui)).not.toContain(BLOCK);
  expect(fs.existsSync(a!.file)).toBe(true);
  await new Promise((r) => setTimeout(r, 300));
  expect(await confirms(sessions)).toMatchObject([{ name: 'run_command', answer: 'yes', by: 'auto', subagent: 'autoy-one-do' }]);
  ui.app.unmount();
});

test('--auto does not answer run_command while shell.autoRun is off: the block asks', async () => {
  const { children: [a], ui } = await boot(['AUTON-ONE']);
  await ask(ui, '/subagent --auto AUTON-ONE do it');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  expect(fs.existsSync(a!.file)).toBe(false);
  pause();
  await ui.press('n');
  await settleUntil(() => frameOf(ui).includes('◆ auton-one-do finished:'));
  expect(fs.existsSync(a!.file)).toBe(false);
  ui.app.unmount();
});

test('the conversation\'s own /auto all does not reach a subagent started without the flag', async () => {
  const { children: [a], ui } = await boot(['PARENT-ONE'], { autoRun: true });
  await ask(ui, '/auto all');
  await settle(4);
  await ask(ui, '/subagent PARENT-ONE do it');
  await settleUntil(() => frameOf(ui).includes(BLOCK));
  expect(fs.existsSync(a!.file)).toBe(false);
  pause();
  await ui.press('y');
  await settleUntil(() => fs.existsSync(a!.file));
  ui.app.unmount();
});
