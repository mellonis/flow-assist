// The hint row's count of the other sessions: `⏸ N` for ones left on a y/n or a question,
// `● N` for ones put away with an answer nobody read (AGENTS.md (a host makes its
// conversations through one registry)).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptedConfigPath, hostStateDir, resetSessionConfig, unguardConfigFiles } from '../config/load.ts';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';
import { acquireLock } from '../assistant/sessions.ts';
import { homeIn, listTree } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  unguardConfigFiles();
  resetSessionConfig();
  fs.rmSync(path.join(hostStateDir(), 'config.local.json'), { force: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
});

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-attention-'));
type Saved = { id: string; messages: { role: string; content: unknown }[] };
const saved = (dir: string, text: string): Saved | undefined => listTree(dir).filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Saved)
  .find((s) => s.messages.some((m) => m.content === text));
const lockOf = (dir: string, id: string) => path.join(homeIn(dir, id), `${id}.lock`);
const frameOf = (ui: { backend: { lastFrame?: string } }) => ui.backend.lastFrame ?? '';
// The hint row: the one the history hint (or, while a turn streams, `Esc stops`) is on.
const hintRow = (frame: string, anchor = 'history · wheel') => frame.split('\n').find((r) => r.includes(anchor)) ?? '';
type UI = Awaited<ReturnType<typeof bootApp>>;
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
async function pick(ui: UI, text: string) {
  ui.backend.press({ name: 's', ctrl: true });
  await settle(3);
  const rows = frameOf(ui).split('\n').filter((r) => / msgs? │/.test(r));
  const at = rows.findIndex((r) => r.includes(text));
  if (at < 0) throw new Error(`pick: no row with ${text}`);
  for (let i = 0; i < at; i++) { await ui.press('down'); await settle(1); }
  await ui.press('return');
  await settle(4);
}

// A holds its turn (one request, then the answer); `/new` leaves it for B, which answers.
async function leftHeld(last: Parameters<ScriptedModel['script']>[0][]) {
  const dir = dirOf();
  const model = new ScriptedModel();
  const aSub = model.when((req) => firstUser(req).includes('session A question'));
  aSub.script(...last);
  const bSub = model.when((req) => firstUser(req).includes('session B question'));
  bSub.script([{ text: 'B answer.' }]);
  const cSub = model.when((req) => firstUser(req).includes('session C question'));
  cSub.script([{ hold: true }, { text: 'C answer.' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } }, { toastMs: 10_000 });
  await ui.press('F');
  await ask(ui, 'session A question');
  await settleUntil(() => aSub.held && !!saved(dir, 'session A question'));
  const idA = saved(dir, 'session A question')!.id;
  await ask(ui, '/new');
  await settle(4);
  await ask(ui, 'session B question');
  await settleUntil(() => frameOf(ui).includes('B answer.'));
  return { dir, ui, aSub, cSub, idA };
}

test('a session left on a y/n shows ⏸ 1 on the other session\'s hint row; answered and left again, nothing', async () => {
  const { dir, ui, aSub, idA } = await leftHeld([[{ hold: true }, { tool: 'run_command', args: { command: 'echo hi' } }], [{ text: 'Ran it.' }]]);
  expect(hintRow(frameOf(ui))).not.toMatch(/⏸|●/);
  aSub.release();
  await settleUntil(() => hintRow(frameOf(ui)).includes('⏸ 1'));
  expect(hintRow(frameOf(ui))).toContain('⏸ 1');
  expect(hintRow(frameOf(ui))).not.toContain('●');
  await pick(ui, 'session A question');
  await settle(10);
  expect(hintRow(frameOf(ui))).not.toContain('⏸'); // A is on screen now: never counted
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('Ran it.'));
  await ask(ui, '/new');
  await settle(6);
  expect(fs.existsSync(lockOf(dir, idA))).toBe(false);
  expect(hintRow(frameOf(ui))).not.toMatch(/⏸|●/);
  ui.app.unmount();
});

test('a session left that finishes shows ● 1 and a toast but no alert; opened it is gone, and stays gone once left again', async () => {
  const { dir, ui, aSub, idA } = await leftHeld([[{ hold: true }, { text: 'A final answer.' }]]);
  let toast = false;
  aSub.release();
  await settleUntil(() => { if (frameOf(ui).includes('finished — its answer is unread')) toast = true; return toast && !fs.existsSync(lockOf(dir, idA)); });
  expect(toast).toBe(true);
  expect(ui.backend.notifications.filter((n) => JSON.stringify(n).includes('finished'))).toHaveLength(0);
  await settleUntil(() => hintRow(frameOf(ui)).includes('● 1'));
  expect(hintRow(frameOf(ui))).toContain('● 1');
  expect(hintRow(frameOf(ui))).not.toContain('⏸');
  await pick(ui, 'session A question');
  expect(frameOf(ui)).toContain('A final answer.');
  expect(hintRow(frameOf(ui))).not.toContain('●');
  // Left again, it is not unread: it was shown.
  await pick(ui, 'session B question');
  await settle(6);
  expect(hintRow(frameOf(ui))).not.toContain('●');
  ui.app.unmount();
});

test('while the session on screen streams, the badge stays on the hint row', async () => {
  const { dir, ui, aSub, cSub, idA } = await leftHeld([[{ hold: true }, { text: 'A final answer.' }]]);
  aSub.release();
  await settleUntil(() => !fs.existsSync(lockOf(dir, idA)));
  await ask(ui, '/new'); // C: a session of its own, so the scripted turn matches
  await settle(4);
  await ask(ui, 'session C question');
  await settleUntil(() => cSub.held);
  const row = hintRow(frameOf(ui), 'Esc stops');
  expect(row).toContain('Esc stops');
  expect(row).toContain('● 1');
  cSub.release();
  await settleUntil(() => frameOf(ui).includes('C answer.'));
  ui.app.unmount();
});

test('an answer landing in the session on screen behind the picker is not counted for it', async () => {
  const { ui, aSub, cSub } = await leftHeld([[{ hold: true }, { text: 'A final answer.' }]]);
  aSub.release();
  await settle(10);
  await ask(ui, '/new'); // C: a session of its own, so the scripted turn matches
  await settle(4);
  await ask(ui, 'session C question');
  await settleUntil(() => cSub.held);
  ui.backend.press({ name: 's', ctrl: true });
  await settle(4);
  cSub.release();
  await settleUntil(() => frameOf(ui).includes('this chat · done'));
  expect(frameOf(ui)).toContain('this chat · done');
  await ui.press('escape');
  await settle(6);
  // Only A, put away unread, is counted; C is on screen.
  expect(hintRow(frameOf(ui))).toContain('● 1');
  expect(hintRow(frameOf(ui))).not.toContain('● 2');
  ui.app.unmount();
});

test('a session opened by /resume is not owed any more, and no picker read has to say so', async () => {
  const { dir, ui, aSub, idA } = await leftHeld([[{ hold: true }, { text: 'A final answer.' }]]);
  aSub.release();
  await settleUntil(() => !fs.existsSync(lockOf(dir, idA)));
  await settleUntil(() => hintRow(frameOf(ui)).includes('● 1'));
  ui.backend.press({ name: 's', ctrl: true });
  await settle(3);
  const rows = frameOf(ui).split('\n');
  await ui.press('escape');
  await settle(2);
  const n = rows.filter((r) => /session [AB] question/.test(r)).findIndex((r) => r.includes('session A question')) + 1;
  await ask(ui, `/resume ${n}`);
  await settleUntil(() => frameOf(ui).includes('A final answer.'));
  expect(hintRow(frameOf(ui))).not.toContain('●');
  await ask(ui, '/new');
  await settle(6);
  expect(hintRow(frameOf(ui))).not.toContain('●');
  ui.app.unmount();
});

// ─── What a picker read reconciles ────────────────────────────────────────────
// A put away unread (`● 1` on B's hint row); the picker is opened and closed, which reads
// the saved list again.
async function parkedUnread() {
  const t = await leftHeld([[{ hold: true }, { text: 'A final answer.' }]]);
  t.aSub.release();
  await settleUntil(() => !fs.existsSync(lockOf(t.dir, t.idA)));
  await settleUntil(() => hintRow(frameOf(t.ui)).includes('● 1'));
  expect(hintRow(frameOf(t.ui))).toContain('● 1');
  return t;
}
async function readThePicker(ui: UI) {
  ui.backend.press({ name: 's', ctrl: true });
  await settle(4);
  await ui.press('escape');
  await settle(6);
}
const jsonOf = (dir: string, id: string) => path.join(homeIn(dir, id), `${id}.json`);

test('a session whose file is gone is no longer counted once the picker has read the list', async () => {
  const { dir, ui, idA } = await parkedUnread();
  for (const n of listTree(dir)) if (path.basename(n).startsWith(idA)) fs.rmSync(path.join(dir, n));
  expect(hintRow(frameOf(ui))).toContain('● 1'); // nothing has read the list yet
  await readThePicker(ui);
  expect(hintRow(frameOf(ui))).not.toContain('●');
  ui.app.unmount();
});

test('a session another process holds is no longer counted once the picker has read the list', async () => {
  const { dir, ui, idA } = await parkedUnread();
  expect(acquireLock(homeIn(dir, idA), idA, 'another-process').status).toBe('acquired');
  await readThePicker(ui);
  expect(hintRow(frameOf(ui))).not.toContain('●');
  ui.app.unmount();
});

test('a session whose file reads as read is no longer counted once the picker has read the list', async () => {
  const { dir, ui, idA } = await parkedUnread();
  const file = jsonOf(dir, idA);
  const s = JSON.parse(fs.readFileSync(file, 'utf8')) as { seenAt?: string; answeredAt?: string };
  s.seenAt = '9999-12-31T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(s));
  await readThePicker(ui);
  expect(hintRow(frameOf(ui))).not.toContain('●');
  ui.app.unmount();
});

test('a session deleted from the picker is no longer counted', async () => {
  const { ui } = await parkedUnread();
  ui.backend.press({ name: 's', ctrl: true });
  await settle(4);
  await ui.press('down');
  ui.backend.press({ name: 'x', ctrl: true });
  await settle(4);
  await ui.press('y');
  await settle(4);
  expect(frameOf(ui)).toContain('Deleted «session A question»');
  await ui.press('escape');
  await settle(6);
  expect(hintRow(frameOf(ui))).not.toContain('●');
  ui.app.unmount();
});
