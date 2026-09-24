// A restart continues the conversation: what the MODEL is sent, not only what the
// screen shows — a restored screen over an empty history looks right and is the bug.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SESSION_VERSION, newSessionId, saveSession, type Session } from '../assistant/sessions.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sess-e2e-'));
// A long note wraps inside the chat's fixed-width box, splitting even mid-word (a
// session id's own hyphen can fall right on the wrap boundary) — and the box's own
// border characters sit right at that boundary too (a row's closing `│` butts up
// against the next row's opening one). Flattening both sides — whitespace and
// border-drawing characters alike — before `toContain` makes the check care about
// the text, not where the terminal happened to break the line.
const flat = (s: string) => s.replace(/[\s│╭╮╰╯─]+/g, '');
type Sent = { role: string; content: unknown }[];
const sentTo = (m: ScriptedModel) => m.requests.at(-1)!.messages as Sent;

async function talk(dir: string, question: string, answer: string) {
  const model = new ScriptedModel();
  model.script([{ text: answer }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await ui.press('F');
  await ui.type(question);
  await ui.press('return');
  await settle(20);
  return { ui, model };
}

test('after a restart the chat is back — on screen and in what the model is sent', async () => {
  const dir = dirOf();
  const first = await talk(dir, 'как тренд по ABC-341?', 'Тренд — вверх, +4% за неделю.');
  await first.ui.type('а на след');
  await wait(350); // the debounced save
  first.ui.app.unmount();

  const model = new ScriptedModel();
  model.script([{ text: 'Держится.' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await settle(6);
  await ui.press('F');
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('как тренд по ABC-341?');
  expect(frame).toContain('Тренд — вверх, +4% за неделю.');
  expect(frame).toContain('› а на след'); // the unsent draft too

  await ui.type('ующей неделе?');
  await ui.press('return');
  await settle(20);
  const sent = sentTo(model);
  expect(sent.some((m) => m.role === 'user' && m.content === 'как тренд по ABC-341?')).toBe(true);
  expect(sent.some((m) => m.role === 'assistant' && String(m.content).includes('Тренд — вверх'))).toBe(true);
  expect(sent.at(-1)).toMatchObject({ role: 'user', content: 'а на следующей неделе?' });
  ui.app.unmount();
});

test('closing the chat saves at once; /clear starts anew and a restart does not bring the cleared chat back', async () => {
  const dir = dirOf();
  const first = await talk(dir, 'первый вопрос', 'первый ответ');
  await first.ui.press('escape', 'escape'); // closed — written without waiting
  expect(fs.readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(1);
  await first.ui.press('F');
  await first.ui.type('/clear');
  await first.ui.press('return');
  await settle(4);
  first.ui.app.unmount();

  const model = new ScriptedModel();
  model.script([{ text: 'снова первый ответ' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await settle(6);
  await ui.press('F');
  expect(ui.backend.lastFrame).not.toContain('первый вопрос');

  // …but it is on the list, and /resume brings it back to the model too.
  await ui.type('/resume');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toMatch(/1\. первый вопрос — /);
  await ui.type('/resume 1');
  await ui.press('return');
  await settle(4);
  expect(ui.backend.lastFrame).toContain('первый ответ');
  await ui.type('и ещё');
  await ui.press('return');
  await settle(20);
  expect(sentTo(model).some((m) => m.role === 'user' && m.content === 'первый вопрос')).toBe(true);
  ui.app.unmount();
});

test('a broken session file does not stop the app from starting', async () => {
  const dir = dirOf();
  fs.writeFileSync(path.join(dir, '2026-09-21T10-00-00-abcd.json'), '{"version":1,"messa');
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await settle(6);
  await ui.press('F');
  await ui.type('привет');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('ok');
  ui.app.unmount();
});

// ─── two processes on one session ─────────────────────────────────────────────

test('a second process avoids a session the first still holds — starts a new one and says so; the first is untouched', async () => {
  const dir = dirOf();
  const first = await talk(dir, 'первый вопрос', 'первый ответ');
  await first.ui.press('escape', 'escape'); // closed — written and locked, at once; the process stays alive
  const files1 = fs.readdirSync(dir);
  expect(files1.filter((n) => n.endsWith('.json'))).toHaveLength(1);
  expect(files1.filter((n) => n.endsWith('.lock'))).toHaveLength(1);
  const heldFile = files1.find((n) => n.endsWith('.json'))!;

  const lockName = files1.find((n) => n.endsWith('.lock'))!;

  const model2 = new ScriptedModel();
  model2.script([{ text: 'второй ответ' }]);
  const ui2 = await bootApp(model2, 100, 28, undefined, { sessions: { dir } });
  await settle(6);
  await ui2.press('F');
  const frame = ui2.backend.lastFrame!;
  expect(frame).not.toContain('первый ответ'); // the held conversation itself was not continued
  expect(frame).toContain('Session "первый вопрос" is open in another flow-assist process'); // wraps before "started a new one."
  expect(frame).toContain('started a new');
  expect(flat(frame)).toContain(flat(`(lock: ${path.join(dir, lockName)})`)); // names the lock a person can go clear

  await ui2.type('второй вопрос');
  await ui2.press('return');
  await settle(20);
  await ui2.press('escape', 'escape'); // save app2's own new session
  ui2.app.unmount();
  first.ui.app.unmount();

  const jsonFiles = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  expect(jsonFiles).toHaveLength(2); // the first's original session, plus the second's new one
  const heldAfter = JSON.parse(fs.readFileSync(path.join(dir, heldFile), 'utf8'));
  expect(heldAfter.messages.some((m: { role: string; content: unknown }) => m.role === 'user' && m.content === 'первый вопрос')).toBe(true);
  expect(heldAfter.messages.some((m: { content: unknown }) => m.content === 'второй вопрос')).toBe(false);
});

test('/resume of a session another live instance holds refuses with a note and stays where it is', async () => {
  const dir = dirOf();
  const first = await talk(dir, 'held-vopros', 'held-otvet');
  await first.ui.press('escape', 'escape'); // held: saved and locked, the process stays alive
  const lockName = fs.readdirSync(dir).find((n) => n.endsWith('.lock'))!;

  const model2 = new ScriptedModel();
  model2.script([{ text: 'own-otvet' }]);
  const ui2 = await bootApp(model2, 100, 28, undefined, { sessions: { dir } });
  await settle(6); // starts its own session — the first's is held
  await ui2.press('F');
  await ui2.type('own-vopros');
  await ui2.press('return');
  await settle(20);
  await ui2.press('escape', 'escape'); // save app2's own session so /resume has two to list

  await ui2.press('F');
  await ui2.type('/resume');
  await ui2.press('return');
  await settle(4);
  const list = ui2.backend.lastFrame!;
  const idx = list.match(/(\d+)\.\s*held-vopros/)?.[1];
  expect(idx).toBeTruthy();

  await ui2.type(`/resume ${idx}`);
  await ui2.press('return');
  await settle(4);
  const frame = ui2.backend.lastFrame!;
  expect(frame).toContain('Session "held-vopros" is open in another flow-assist process.');
  expect(flat(frame)).toContain(flat(`(lock: ${path.join(dir, lockName)})`));
  expect(frame).not.toContain('held-otvet'); // stayed on its own session

  ui2.app.unmount();
  first.ui.app.unmount();
});

test('a stale lock — its process gone — is taken over on start; the app continues that session', async () => {
  const dir = dirOf();
  const id = newSessionId();
  const s: Session = {
    version: SESSION_VERSION, id, title: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ role: 'user', content: 'stale-owner question' }, { role: 'assistant', content: 'stale-owner answer' }],
    api: [{ role: 'user', content: 'stale-owner question' }, { role: 'assistant', content: 'stale-owner answer' }],
    summary: '', plan: [], usage: null, prompts: [], draft: '',
  };
  saveSession(dir, s);
  const dead = spawnSync('true'); // finished by the time spawnSync returns — a pid that is gone
  fs.writeFileSync(path.join(dir, `${id}.lock`), JSON.stringify({ pid: dead.pid, host: os.hostname(), token: 'a-gone-process-token', at: new Date().toISOString() }), { mode: 0o600 });

  const model = new ScriptedModel();
  model.script([{ text: 'continued' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await settle(6);
  await ui.press('F');
  const frame = ui.backend.lastFrame!;
  expect(frame).toContain('stale-owner question');
  expect(frame).not.toContain('is open in another flow-assist process');

  const lock = JSON.parse(fs.readFileSync(path.join(dir, `${id}.lock`), 'utf8'));
  expect(lock.token).not.toBe('a-gone-process-token');
  expect(lock.pid).toBe(process.pid);
  ui.app.unmount();
});

test('a foreign write between two saves forks into a new session — both a bumped and a dropped rev', async () => {
  for (const mutate of [
    (raw: Record<string, unknown>) => ({ ...raw, rev: (Number(raw.rev) || 0) + 5, messages: [...(raw.messages as unknown[]), { role: 'user', content: 'FOREIGN EDIT' }] }),
    (raw: Record<string, unknown>) => { const { rev: _rev, ...rest } = raw; return { ...rest, messages: [...(raw.messages as unknown[]), { role: 'user', content: 'FOREIGN EDIT' }] }; },
  ]) {
    const dir = dirOf();
    const first = await talk(dir, 'q1', 'a1');
    await first.ui.press('escape', 'escape'); // save #1 — establishes the rev this instance knows
    const name = fs.readdirSync(dir).find((n) => n.endsWith('.json'))!;
    const file = path.join(dir, name);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(mutate(raw))); // a foreign write this instance never saw

    await first.ui.press('F');
    await first.ui.type('q2');
    await first.ui.press('return');
    await settle(20);
    await first.ui.press('escape', 'escape'); // the next save — must fork, not overwrite
    await first.ui.press('F'); // reopen to see the note the closing save left

    const frame = first.ui.backend.lastFrame!;
    expect(flat(frame)).toContain(flat('was changed elsewhere — saved this conversation as a new session.'));

    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(files).toHaveLength(2);
    const originalStill = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(originalStill.messages.some((m: { content: unknown }) => m.content === 'FOREIGN EDIT')).toBe(true);
    expect(originalStill.messages.some((m: { content: unknown }) => m.content === 'q2')).toBe(false);
    const forkedName = files.find((n) => n !== name)!;
    const forked = JSON.parse(fs.readFileSync(path.join(dir, forkedName), 'utf8'));
    expect(forked.messages.some((m: { content: unknown }) => m.content === 'q1')).toBe(true);
    expect(forked.messages.some((m: { content: unknown }) => m.content === 'q2')).toBe(true);
    expect(forked.messages.some((m: { content: unknown }) => m.content === 'FOREIGN EDIT')).toBe(false);

    first.ui.app.unmount();
  }
});

test('a hand edit that leaves rev untouched still forks — mtimeMs/size catch what rev alone misses', async () => {
  const dir = dirOf();
  const first = await talk(dir, 'q1', 'a1');
  await first.ui.press('escape', 'escape'); // save #1 — establishes the fingerprint this instance knows
  const name = fs.readdirSync(dir).find((n) => n.endsWith('.json'))!;
  const file = path.join(dir, name);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  await new Promise((r) => setTimeout(r, 5)); // a distinguishable mtime even on a coarse clock
  // Same rev, different content — exactly what a rev-only check would miss.
  fs.writeFileSync(file, JSON.stringify({ ...raw, messages: [...raw.messages, { role: 'user', content: 'HAND EDIT SAME REV' }] }));

  await first.ui.press('F');
  await first.ui.type('q2');
  await first.ui.press('return');
  await settle(20);
  await first.ui.press('escape', 'escape'); // the next save — must fork, not overwrite
  await first.ui.press('F');

  const frame = first.ui.backend.lastFrame!;
  expect(flat(frame)).toContain(flat('was changed elsewhere — saved this conversation as a new session.'));

  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  expect(files).toHaveLength(2);
  const originalStill = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(originalStill.rev).toBe(raw.rev); // untouched — the fork never overwrote it, rev included
  expect(originalStill.messages.some((m: { content: unknown }) => m.content === 'HAND EDIT SAME REV')).toBe(true);
  expect(originalStill.messages.some((m: { content: unknown }) => m.content === 'q2')).toBe(false);
  first.ui.app.unmount();
});

test('a legacy session (no rev field) changed elsewhere by another legacy writer (still no rev) still forks', async () => {
  const dir = dirOf();
  const id = newSessionId();
  const legacy = {
    version: SESSION_VERSION, id, title: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ role: 'user', content: 'legacy q' }, { role: 'assistant', content: 'legacy a' }],
    api: [{ role: 'user', content: 'legacy q' }, { role: 'assistant', content: 'legacy a' }],
    summary: '', plan: [], usage: null, prompts: [], draft: '',
    // No `rev` at all — an older host wrote this.
  };
  const file = path.join(dir, `${id}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(legacy));

  const model = new ScriptedModel();
  model.script([{ text: 'continued' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await settle(6);
  await ui.press('F'); // continues the legacy session — nothing has a lock on it yet

  await new Promise((r) => setTimeout(r, 5));
  // Still no `rev` — another writer just as old as the first — but different content.
  fs.writeFileSync(file, JSON.stringify({ ...legacy, messages: [...legacy.messages, { role: 'user', content: 'FOREIGN LEGACY EDIT' }] }));

  await ui.type('q2');
  await ui.press('return');
  await settle(20);
  await ui.press('escape', 'escape');
  await ui.press('F');

  const frame = ui.backend.lastFrame!;
  expect(flat(frame)).toContain(flat('was changed elsewhere — saved this conversation as a new session.'));

  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  expect(files).toHaveLength(2);
  const originalStill = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(originalStill.rev).toBeUndefined(); // the foreign legacy write, still untouched
  expect(originalStill.messages.some((m: { content: unknown }) => m.content === 'FOREIGN LEGACY EDIT')).toBe(true);
  expect(originalStill.messages.some((m: { content: unknown }) => m.content === 'q2')).toBe(false);
  ui.app.unmount();
});

test('the lock is released on unmount and on /clear', async () => {
  const dir = dirOf();
  const first = await talk(dir, 'q', 'a');
  await first.ui.press('escape', 'escape');
  expect(fs.readdirSync(dir).filter((n) => n.endsWith('.lock'))).toHaveLength(1);
  first.ui.app.unmount();
  expect(fs.readdirSync(dir).filter((n) => n.endsWith('.lock'))).toHaveLength(0);

  const dir2 = dirOf();
  const second = await talk(dir2, 'q2', 'a2');
  await second.ui.press('escape', 'escape');
  expect(fs.readdirSync(dir2).filter((n) => n.endsWith('.lock'))).toHaveLength(1);
  await second.ui.press('F');
  await second.ui.type('/clear');
  await second.ui.press('return');
  await settle(4);
  expect(fs.readdirSync(dir2).filter((n) => n.endsWith('.lock'))).toHaveLength(0);
  second.ui.app.unmount();
});
