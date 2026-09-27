// Where the chat's shell starts, through the real app: the app's own start directory
// (`shell.ts`, `shellCwd`/`startNote`) when it lies inside a configured root — a
// project of its own, `!pwd` running there, its AGENTS.md read, its session filed
// under its mirror — else the first root, with the chat saying so once. The test rig
// injects the start directory (`bootApp`'s `startDir`, `setStartDirForTests`); nothing
// in the app itself ever calls `process.chdir`.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { journalPath, projectHome } from '../assistant/sessions';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { listTree } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settleUntil = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};

test('started inside a root\'s repo: !pwd runs there, its AGENTS.md is picked up, and the session files under its mirror', async () => {
  const root = tmp('fa-start-root-');
  const sessDir = tmp('fa-start-sessions-');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Repo\nSTART-CWD RULE: say hi.');
  const model = new ScriptedModel();
  const ui = await bootApp(model, 140, 32, undefined, { shell: { roots: [root] }, sessions: { dir: sessDir } }, { startDir: repo });
  await ui.press('F');
  // No note about the roots — the start directory was inside one.
  await settle(4);
  expect(ui.backend.lastFrame).not.toContain('outside shell.roots');
  await ui.type('!pwd');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('pwd · ✓') || /pwd\s*·/.test(ui.backend.lastFrame));
  // The project's own instructions are in the system prompt of the next request.
  await ui.type('go');
  await ui.press('return');
  await settleUntil(() => model.requests.length > 0);
  type Sent = { role: string; content: unknown }[];
  const sys = String((model.requests[0]!.messages as Sent).find((m) => m.role === 'system')?.content ?? '');
  expect(sys).toContain('START-CWD RULE');
  // The session lands under the repo's own mirror, not the root's.
  await ui.press('escape', 'escape'); // closed — written at once
  const home = projectHome(sessDir, repo);
  const files = listTree(sessDir);
  const state = files.find((n) => n.endsWith('.json'));
  expect(state).toBeDefined();
  expect(path.dirname(path.join(sessDir, state!))).toBe(home);
  const id = path.basename(state!).replace(/\.json$/, '');
  expect(fs.existsSync(journalPath(home, id))).toBe(true);
  ui.app.unmount();
});

test('started outside every root: the first one takes over, and the chat says so once', async () => {
  const root = tmp('fa-start-root-');
  const outside = tmp('fa-start-outside-');
  const model = new ScriptedModel();
  const ui = await bootApp(model, 140, 32, undefined, { shell: { roots: [root] } }, { startDir: outside });
  await ui.press('F');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('outside shell.roots');
  await ui.type('!pwd');
  await ui.press('return');
  await settleUntil(() => /pwd\s*·/.test(ui.backend.lastFrame));
  // The command itself ran in the first root, not the start directory — the note
  // above is the only place `outside` legitimately appears.
  const cmdLine = ui.backend.lastFrame!.split('\n').find((l) => l.includes('$ pwd'))!;
  expect(cmdLine).toContain(root);
  expect(cmdLine).not.toContain(outside);
  ui.app.unmount();
});

test('a background task starts where its parent conversation\'s shell currently is, not at the default', async () => {
  const root = tmp('fa-start-root-');
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  const outside = tmp('fa-start-outside-');
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'cd', args: { path: 'sub' } }],
    [{ tool: 'background', args: { task: 'where am I' } }],
    [{ text: 'Started it in the background.' }],
    // The nested run: asks its own shell where it is (read-only — no y/n).
    [{ tool: 'cd', args: { path: '.' } }],
    [{ text: 'Done.' }],
  );
  // Started outside the root — the chat's own default would be the first root, `root`
  // itself; the background task must start at `sub` (where the `cd` above left it),
  // never at that default.
  const ui = await bootApp(model, 140, 32, undefined, { shell: { roots: [root] } }, { startDir: outside });
  await ui.press('F');
  await ui.type('go to sub');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('now in'));
  await ui.type('find out where in the background');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Started it in the background.'));
  await settle(30);
  // Every request carries the WHOLE conversation so far, so the same tool result
  // reappears in each later request of the same conversation — count distinct texts.
  type Sent = { role: string; content: unknown }[];
  const cdResults = new Set(model.requests.flatMap((r) => r.messages as Sent).filter((m) => m.role === 'tool').map((m) => String(m.content)).filter((c) => c.includes('now in')));
  // The parent's own `cd sub` result, and the nested background run's own `cd .` —
  // both land in the same directory, since the background task started AT the
  // parent's current directory, `sub`, not at the app's default (the first root).
  expect([...cdResults]).toEqual([`OK: now in ${sub}\nno AGENTS.md between here and ${root}`]);
  ui.app.unmount();
});
