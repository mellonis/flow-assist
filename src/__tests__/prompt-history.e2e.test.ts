// Every submitted line goes into ↑/↓ — a message, a `/command`, a `!command`, a line run
// in shell mode — and the history rides in the session. A command declared with
// `history: false` is never recalled.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Make } from '../loader/plugin.ts';
import { ScriptedModel, bootApp, settle, settleUntil as settleUntilShared } from './helpers/scripted';
import { sessionFiles } from './helpers/session-files';

import { nativeFetch } from './helpers/test-setup.ts';
const realFetch = nativeFetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
// A real process finishes on its own clock, not the test backend's.
const settleUntil = async (cond: () => boolean, ms = 3000) => settleUntilShared(cond, { ms });
const promptsIn = (dir: string): string[] => {
  const name = sessionFiles(dir)[0]!;
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

test('walking history never opens suggestions', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 28);
  const fieldRow = () => ui.backend.lastFrame.split('\n').filter((r) => r.includes('› ')).at(-1) ?? '';
  await ui.press('F');
  // A line being typed offers its candidates: `/mo` has `/mode` and `/model`.
  await ui.type('/mo');
  expect(ui.backend.lastFrame).toContain('the chat\'s layout');
  await ui.press('return');
  await settle(4);
  // The unknown command leaves the line as typed: Esc closes its list, the next one
  // clears the field.
  await ui.press('escape', 'escape');
  expect(ui.backend.lastFrame).not.toContain('› /mo');
  // ↑ recalls it. A recalled line is not one being typed: no list rows, no inline rest —
  // but the hint beside the field still names what Tab would take, so Tab is no secret.
  await ui.press('up');
  expect(fieldRow()).toContain('› /mo');
  expect(fieldRow()).not.toContain('› /mode');
  expect(ui.backend.lastFrame).not.toContain('the chat\'s layout');
  expect(ui.backend.lastFrame).not.toContain('the model this conversation runs');
  expect(ui.backend.lastFrame).toContain('⇥ model');
  // Tab takes the offer on a recalled line as it always did, and its hint follows the
  // walk: the line holds `/mode`, the hint names `/model`; then the line holds `/model`
  // and the hint names `/mode`.
  await ui.press('tab');
  expect(fieldRow()).toContain('› /mode');
  expect(ui.backend.lastFrame).toContain('⇥ model');
  await ui.press('tab');
  expect(fieldRow()).toContain('› /model');
  expect(ui.backend.lastFrame).toContain('⇥ mode');
  // Back to the empty field, recalled again: one character typed is a content edit, and
  // the list is back.
  await ui.press('escape');
  await ui.press('up');
  await ui.type('d');
  expect(fieldRow()).toContain('› /mod');
  expect(ui.backend.lastFrame).toMatch(/mode +the chat's layout/);
  expect(ui.backend.lastFrame).toMatch(/model +the model this conversation runs/);
  ui.app.unmount();

  // The `:` line is the same one rule: ↑ recalls a command with no rows and no rest, the
  // hint beside the line stays, and Tab rewrites the line to the candidate it names.
  const line = await bootApp(new ScriptedModel(), 100, 24);
  await line.press(':');
  await line.type('c');
  expect(line.backend.lastFrame).toMatch(/cache +Turn the cache on or off/);
  await line.press('return');
  await line.press(':');
  await line.press('up');
  expect(line.backend.lastFrame).toContain(': c');
  expect(line.backend.lastFrame).not.toMatch(/cache +Turn the cache on or off/);
  expect(line.backend.lastFrame).not.toContain(': cache');
  expect(line.backend.lastFrame).toContain('⇥ ');
  expect(line.backend.lastFrame).toContain('clear');
  await line.press('tab');
  expect(line.backend.lastFrame).toContain(': cache');
  expect(line.backend.lastFrame).toMatch(/⇥ .*clear/);
  line.app.unmount();
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
