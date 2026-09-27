// Sessions per project: a session's files live under a mirror of the project it started
// in; a start continues the current project's newest; the picker opens on the current
// project and shows every session on Tab. A flat file from an older host loads where
// it is and stays there.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SESSION_VERSION, journalPath, newSessionId, projectHome, saveSession, type Session } from '../assistant/sessions.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { listTree } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const rowOf = (frame: string, text: string) => frame.split('\n').find((r) => r.includes(text)) ?? '';
const session = (question: string, updatedAt: string, project: string | null = null): Session => ({
  version: SESSION_VERSION, id: newSessionId(new Date(updatedAt)), title: '', createdAt: updatedAt, updatedAt,
  messages: [{ role: 'user', content: question }, { role: 'assistant', content: `${question} — answer` }],
  api: [{ role: 'user', content: question }, { role: 'assistant', content: `${question} — answer` }],
  summary: '', plan: [], usage: null, prompts: [], draft: '', ...(project ? { project } : {}),
});

async function boot(dir: string, roots: string[], ...answers: string[]) {
  const model = new ScriptedModel();
  model.script(...answers.map((text) => [{ text }]));
  const ui = await bootApp(model, 110, 30, undefined, { sessions: { dir }, shell: { roots } });
  await settle(6);
  const ask = async (q: string) => { await ui.type(q); await ui.press('return'); await settle(20); };
  const chord = async (name: string) => { ui.backend.press({ name, ctrl: true }); await settle(); };
  return { ui, model, ask, chord };
}

test('a session started in a root lands under its mirror directory — the state file, the journal and the lock together, the project recorded', async () => {
  const dir = tmp('fa-proj-sessions-');
  const app = tmp('fa-proj-app-');
  const t = await boot(dir, [app], 'answer here');
  await t.ui.press('F');
  await t.ask('a question in the app');
  const home = projectHome(dir, app);
  expect(home).toBe(path.join(dir, ...app.split('/').filter(Boolean)));
  const lock = fs.readdirSync(home).find((n) => n.endsWith('.lock'))!;
  expect(lock).toBeDefined(); // held from the first message, beside where the file goes
  await t.ui.press('escape', 'escape'); // closed — written at once
  const files = fs.readdirSync(home);
  const state = files.find((n) => n.endsWith('.json'))!;
  const id = state.replace(/\.json$/, '');
  expect(JSON.parse(fs.readFileSync(path.join(home, state), 'utf8')).project).toBe(app);
  expect(fs.existsSync(journalPath(home, id))).toBe(true);
  expect(listTree(dir).filter((n) => n.endsWith('.json'))).toEqual([path.relative(dir, path.join(home, state))]); // nothing at the top level
  t.ui.app.unmount();
});

test('a flat file from an older host still loads — as a session with no project — goes on where it is, and never moves', async () => {
  const dir = tmp('fa-proj-sessions-');
  const app = tmp('fa-proj-app-');
  const legacy = session('an old flat question', '2026-09-20T09:00:00.000Z');
  saveSession(dir, legacy);
  const t = await boot(dir, [app], 'more');
  await t.ui.press('F');
  expect(t.ui.backend.lastFrame).not.toContain('an old flat question'); // another project's: not continued
  await t.chord('s');
  await t.ui.press('tab');
  expect(rowOf(t.ui.backend.lastFrame!, 'no project')).toContain('no project');
  await t.ui.press('return');
  await settle(4);
  expect(t.ui.backend.lastFrame).toContain('an old flat question');
  await t.ask('and one more');
  await t.ui.press('escape', 'escape');
  expect(listTree(dir).filter((n) => n.endsWith('.json'))).toEqual([`${legacy.id}.json`]);
  const back = JSON.parse(fs.readFileSync(path.join(dir, `${legacy.id}.json`), 'utf8'));
  expect(back.messages.some((m: { content: unknown }) => m.content === 'and one more')).toBe(true);
  expect(back.project ?? null).toBeNull(); // no project, as it was
  expect(fs.existsSync(journalPath(dir, legacy.id))).toBe(true); // its journal beside it
  t.ui.app.unmount();
});

test("a start continues the current project's newest session, never another project's; with none of its own it starts a new one and says where the others are", async () => {
  const dir = tmp('fa-proj-sessions-');
  const app = tmp('fa-proj-app-');
  const other = tmp('fa-proj-other-');
  saveSession(projectHome(dir, app), session('the app question', '2026-09-20T09:00:00.000Z', app));
  saveSession(projectHome(dir, other), session('the other question', '2026-09-22T09:00:00.000Z', other));
  const t = await boot(dir, [app, other]);
  await t.ui.press('F');
  expect(t.ui.backend.lastFrame).toContain('the app question');
  expect(t.ui.backend.lastFrame).not.toContain('the other question');
  t.ui.app.unmount();
  const fresh = tmp('fa-proj-fresh-');
  const u = await boot(dir, [fresh]);
  expect(u.ui.backend.lastFrame).toContain('No session in this project yet — ^s, then ⇥ for all');
  await u.ui.press('F');
  expect(u.ui.backend.lastFrame).not.toContain('the other question');
  expect(u.ui.backend.lastFrame).not.toContain('the app question');
  // /resume numbers this project's sessions only: none here.
  await u.ask('/resume');
  expect(u.ui.backend.lastFrame).toContain('No saved sessions in this project yet');
  u.ui.app.unmount();
});

test('/resume numbers only the current project\'s sessions', async () => {
  const dir = tmp('fa-proj-sessions-');
  const app = tmp('fa-proj-app-');
  const other = tmp('fa-proj-other-');
  saveSession(projectHome(dir, app), session('app one', '2026-09-20T09:00:00.000Z', app));
  saveSession(projectHome(dir, other), session('other one', '2026-09-22T09:00:00.000Z', other));
  const t = await boot(dir, [app, other]);
  await t.ui.press('F');
  await t.ask('/resume');
  const frame = t.ui.backend.lastFrame!;
  expect(frame).toContain('1. app one');
  expect(frame).not.toContain('other one');
  t.ui.app.unmount();
});

test('the project is decided at the first message: a cd into another root later leaves the session where it began', async () => {
  const dir = tmp('fa-proj-sessions-');
  const a = tmp('fa-proj-a-');
  const b = tmp('fa-proj-b-');
  const t = await boot(dir, [a, b], 'first answer', 'second answer');
  await t.ui.press('F');
  await t.ask('first in A');
  await t.ask(`!cd ${b}`);
  await settle(10);
  await t.ui.press('backspace'); // out of shell mode
  await t.ask('second in B');
  await t.ui.press('escape', 'escape');
  const files = listTree(dir).filter((n) => n.endsWith('.json'));
  expect(files).toHaveLength(1);
  expect(path.join(dir, path.dirname(files[0]!))).toBe(projectHome(dir, a));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), 'utf8'));
  expect(saved.project).toBe(a);
  expect(saved.shellCwd).toBe(b); // the shell did move
  expect(saved.messages.some((m: { content: unknown }) => m.content === 'second in B')).toBe(true);
  expect(fs.existsSync(projectHome(dir, b))).toBe(false);
  t.ui.app.unmount();
});

test('the picker opens on the current project; Tab shows every session under its project, the current one first', async () => {
  const dir = tmp('fa-proj-sessions-');
  const app = tmp('fa-proj-app-');
  const other = tmp('fa-proj-other-');
  saveSession(projectHome(dir, app), session('app older', '2026-09-20T09:00:00.000Z', app));
  saveSession(projectHome(dir, other), session('other newest', '2026-09-23T09:00:00.000Z', other));
  saveSession(dir, session('loose flat one', '2026-09-21T09:00:00.000Z'));
  const t = await boot(dir, [app, other], 'fine');
  await t.ui.press('F');
  await t.ask('/new');
  await t.ask('app newer');
  await t.chord('s');
  let frame = t.ui.backend.lastFrame!;
  expect(frame).toContain('Sessions · 2 ·');
  expect(frame).toContain('app newer');
  expect(frame).toContain('app older');
  expect(frame).not.toContain('other newest');
  expect(frame).not.toContain('loose flat one');
  expect(frame).toContain('⇥ all');

  await t.ui.press('tab');
  frame = t.ui.backend.lastFrame!;
  expect(frame).toContain('Sessions · all · 4');
  const rows = frame.split('\n');
  const at = (s: string) => rows.findIndex((r) => r.includes(s));
  const appHead = at(path.basename(app));
  const otherHead = at(path.basename(other));
  expect(appHead).toBeGreaterThan(-1);
  expect(appHead).toBeLessThan(at('app newer'));
  expect(at('app newer')).toBeLessThan(at('app older'));
  expect(at('app older')).toBeLessThan(otherHead);
  expect(otherHead).toBeLessThan(at('other newest'));
  expect(at('no project')).toBeLessThan(at('loose flat one'));
  expect(at('other newest')).toBeLessThan(at('no project')); // groups follow their newest
  expect(frame).toContain('⇥ this project');

  // The filter works here too; ⏎ opens a session of another project.
  await t.ui.type('other');
  frame = t.ui.backend.lastFrame!;
  expect(frame).toContain('Sessions · all · 1 of 4');
  await t.ui.press('return');
  await settle(4);
  expect(t.ui.backend.lastFrame).toContain('other newest — answer');
  t.ui.app.unmount();
});

test('a delete from the picker removes the state file and the journal under the mirror directory', async () => {
  const dir = tmp('fa-proj-sessions-');
  const app = tmp('fa-proj-app-');
  const t = await boot(dir, [app], 'one', 'two');
  await t.ui.press('F');
  await t.ask('doomed question');
  const home = projectHome(dir, app);
  const doomed = fs.readdirSync(home).find((n) => n.endsWith('.lock'))!.replace(/\.lock$/, ''); // held from the first message
  expect(fs.existsSync(journalPath(home, doomed))).toBe(true);
  await t.ask('/new'); // the other becomes deletable
  await t.ask('kept question');
  await t.chord('s');
  expect(rowOf(t.ui.backend.lastFrame!, 'doomed question')).toContain('doomed question');
  await t.ui.press('down');
  await t.chord('x');
  await t.ui.press('y');
  expect(t.ui.backend.lastFrame).toContain('Deleted «doomed question»');
  expect(fs.existsSync(path.join(home, `${doomed}.json`))).toBe(false);
  expect(fs.existsSync(journalPath(home, doomed))).toBe(false);
  expect(fs.existsSync(path.join(home, `${doomed}.lock`))).toBe(false);
  t.ui.app.unmount();
});

test('a delete from the picker removes a mirror directory it leaves empty', async () => {
  const dir = tmp('fa-proj-sessions-');
  const app = tmp('fa-proj-app-');
  const other = tmp('fa-proj-other-');
  saveSession(projectHome(dir, other), session('the lone other', '2026-09-20T09:00:00.000Z', other));
  const t = await boot(dir, [app], 'fine');
  await t.ui.press('F');
  await t.ask('here');
  await t.chord('s');
  await t.ui.press('tab');
  await t.ui.press('down');
  await t.chord('x');
  await t.ui.press('y');
  expect(t.ui.backend.lastFrame).toContain('Deleted «the lone other»');
  expect(fs.existsSync(projectHome(dir, other))).toBe(false);
  expect(fs.existsSync(dir)).toBe(true);
  t.ui.app.unmount();
});
