// Every submitted line goes into ↑/↓ — a message, a `/command`, a `!command`, a line run
// in shell mode — and the history rides in the session. A command declared with
// `history: false` is never recalled.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Make } from '../loader/plugin.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
// A real process finishes on its own clock, not the test backend's.
const settleUntil = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};
const promptsIn = (dir: string): string[] => {
  const name = fs.readdirSync(dir).find((n) => n.endsWith('.json'))!;
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).prompts;
};

test('a /command goes into the history: /notes open, then ↑ offers it again', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 26);
  await ui.press('F');
  await ui.type('/notes open');
  await ui.press('return');
  expect(ui.backend.lastFrame).not.toContain('› /notes open');
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('› /notes open');
  // An unknown command too — a typo is fixed with ↑, not typed again.
  await ui.press('escape');
  await ui.type('/nots step');
  await ui.press('return');
  await ui.press('escape');
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('› /nots step');
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('› /notes open');
  ui.app.unmount();
});

test('a !command and a shell-mode line both come back with ↑ as shell mode, their text without the !', async () => {
  const root = tmp('fa-hist-shell-');
  const ui = await bootApp(new ScriptedModel(), 110, 30, undefined, { shell: { roots: [root] } });
  await ui.press('F');
  await ui.type('!pwd');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('✓'));
  await ui.type('!'); // shell mode
  await ui.type('echo hi');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.split('✓').length > 2);

  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('! echo hi');
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('! pwd');
  expect(ui.backend.lastFrame).not.toContain('› !pwd');
  ui.app.unmount();
});

test('the history — commands included — is saved with the session and back after a restart', async () => {
  const dir = tmp('fa-hist-sess-');
  const root = tmp('fa-hist-root-');
  const model = new ScriptedModel();
  model.script([{ text: 'Sure.' }]);
  const first = await bootApp(model, 110, 30, undefined, { sessions: { dir }, shell: { roots: [root] } });
  await first.press('F');
  await first.type('a question');
  await first.press('return');
  await settle(14);
  await first.type('/notes open');
  await first.press('return');
  await first.type('!echo saved');
  await first.press('return');
  await settleUntil(() => first.backend.lastFrame.includes('✓'));
  await first.press('escape', 'escape'); // arm, then close: the session is saved at once
  expect(promptsIn(dir)).toEqual(['a question', '/notes open', '!echo saved']);
  first.app.unmount();

  const ui = await bootApp(new ScriptedModel(), 110, 30, undefined, { sessions: { dir }, shell: { roots: [root] } });
  await settle(6);
  await ui.press('F');
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('! echo saved');
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('› /notes open');
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('› a question');
  ui.app.unmount();
});

test('a `:` command declared with history: false is not recalled by ↑; one without the flag is', async () => {
  const guests = (make: Make) => [make('vault', {
    name: 'vault',
    commands: [
      { name: 'login', history: false, run: () => {}, usage: 'login <token>', minArgs: 1, maxArgs: 1, description: 'Log in' },
      { name: 'peek', run: () => {}, usage: 'peek', minArgs: 0, maxArgs: 0, description: 'Peek' },
    ],
  } as never)];
  const ui = await bootApp(new ScriptedModel(), 100, 24, guests);
  await ui.press(':');
  await ui.type('peek');
  await ui.press('return');
  await ui.press(':');
  await ui.type('login s3cret-token');
  await ui.press('return');
  // The host's own `config` says it too: a value set may be a secret.
  await ui.press(':');
  await ui.type('config get ai.model');
  await ui.press('return');

  await ui.press(':');
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain(': peek');
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain(': peek');
  expect(ui.backend.lastFrame).not.toContain('s3cret-token');
  expect(ui.backend.lastFrame).not.toContain('config get');
  ui.app.unmount();
});
