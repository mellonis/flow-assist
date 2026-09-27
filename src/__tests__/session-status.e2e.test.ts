// A status per session in the picker: this chat's while a turn runs, an answer that
// landed while the chat was closed as `done` until a chat shows it.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { listTree } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-status-e2e-'));
const rowOf = (frame: string, text: string) => frame.split('\n').find((r) => r.includes(text)) ?? '';
const CTRL_RIGHT_BRACKET = { name: ']', ctrl: true };
const saved = (dir: string, text: string) => listTree(dir).filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
  .find((s) => s.messages.some((m: { content: unknown }) => m.content === text));

test("this chat's row says working while its turn runs, and nothing once it ends", async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'the long answer' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await ui.press('F');
  await ui.type('a long question');
  await ui.press('return');
  await settle(6);
  ui.backend.press({ name: 's', ctrl: true });
  await settle();
  expect(rowOf(ui.backend.lastFrame!, 'a long question')).toContain('this chat · working');
  model.release();
  await settleUntil(() => !rowOf(ui.backend.lastFrame!, 'a long question').includes('working'));
  expect(rowOf(ui.backend.lastFrame!, 'a long question')).toContain('this chat');
  ui.app.unmount();
});

test('an answer that lands while the chat is closed is done in the picker until a chat shows it', async () => {
  const dir = dirOf();
  const first = new ScriptedModel();
  first.script([{ hold: true }, { text: 'answered behind your back' }]);
  const a = await bootApp(first, 100, 28, undefined, { sessions: { dir } });
  await a.press('F');
  await a.type('the unseen question');
  await a.press('return');
  await settle(6);
  a.backend.press(CTRL_RIGHT_BRACKET); // the chat closes; the turn goes on
  await settle(4);
  first.release();
  await settleUntil(() => saved(dir, 'the unseen question')?.answeredAt !== undefined, 400);
  a.app.unmount(); // written on the way out
  const file = saved(dir, 'the unseen question');
  expect(file.answeredAt > (file.seenAt ?? '')).toBe(true);

  // Another start that does not continue it: the picker says it is done.
  const second = new ScriptedModel();
  second.script([{ text: 'fine' }]);
  const b = await bootApp(second, 100, 28, undefined, { sessions: { dir, resume: false } });
  await settle(6);
  await b.press('F');
  b.backend.press({ name: 's', ctrl: true });
  await settle();
  expect(rowOf(b.backend.lastFrame!, 'the unseen question')).toMatch(/the unseen question\s+done\s/);
  // Opened in an open chat, it is seen: another start's picker no longer says done.
  await b.press('return');
  await settle(4);
  expect(b.backend.lastFrame).toContain('answered behind your back');
  await b.press('escape', 'escape'); // closed — written at once
  b.app.unmount();
  const seen = saved(dir, 'the unseen question');
  expect(seen.seenAt >= seen.answeredAt).toBe(true);
  const c = await bootApp(new ScriptedModel(), 100, 28, undefined, { sessions: { dir, resume: false } });
  await settle(6);
  await c.press('F');
  c.backend.press({ name: 's', ctrl: true });
  await settle();
  expect(rowOf(c.backend.lastFrame!, 'the unseen question')).not.toContain('done');
  c.app.unmount();
});

test('an answer that lands while the chat is open is seen at once', async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  model.script([{ text: 'seen as it came' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir } });
  await ui.press('F');
  await ui.type('an open question');
  await ui.press('return');
  await settle(20);
  await ui.press('escape', 'escape');
  const file = saved(dir, 'an open question');
  expect(typeof file.answeredAt).toBe('string');
  expect(file.seenAt).toBe(file.answeredAt);
  ui.app.unmount();
});
