// The project's instructions through the real chat: the model's `cd` moves the
// shell's directory into a project, the very next request carries its AGENTS.md in the
// system prompt, the chat says which files were picked up, and run_command afterwards
// runs there. The assertions are on what the MODEL is sent, not only on the frame.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rootDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-instr-e2e-')));
type Sent = { role: string; content: unknown }[];
const systemOf = (m: ScriptedModel, i: number) => String((m.requests[i]!.messages as Sent).find((x) => x.role === 'system')?.content ?? '');
const settleUntil = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};
const shown = (p: string) => (p.startsWith(`${os.homedir()}/`) ? `~${p.slice(os.homedir().length)}` : p);

test('cd into a project: the next request carries its AGENTS.md, the chat says so, and run_command runs there', async () => {
  const root = rootDir();
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# Proj\nPROJECT RULE 42: tests before commits.');
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'cd', args: { path: 'proj' } }],
    [{ tool: 'run_command', args: { command: 'pwd' } }],
    [{ text: 'In the project.' }],
  );
  const ui = await bootApp(model, 160, 32, undefined, { shell: { roots: [root] } });
  await ui.press('F');
  await ui.type('go to the project');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  // The first request went out from the root: no section yet.
  expect(systemOf(model, 0)).not.toContain('## Project instructions');
  // The second — the next round of the same turn — carries it, the file under its path.
  const sys = systemOf(model, 1);
  expect(sys).toContain('## Project instructions');
  expect(sys).toContain(`### ${path.join(proj, 'AGENTS.md')}\n# Proj\nPROJECT RULE 42: tests before commits.`);
  // After the memory's place, before nothing it should follow: the base comes first.
  expect(sys.indexOf('## Project instructions')).toBeGreaterThan(sys.indexOf('Always respond in'));
  // The cd's own answer names the directory and the file.
  const cdResult = (model.requests[1]!.messages as Sent).find((x) => x.role === 'tool');
  expect(String(cdResult?.content)).toContain(`now in ${proj}`);
  expect(String(cdResult?.content)).toContain(path.join(proj, 'AGENTS.md'));
  await ui.press('y');
  await settleUntil(() => model.requests.length === 3);
  await settle(10);
  // run_command ran in the project.
  const ran = (model.requests[2]!.messages as Sent).filter((x) => x.role === 'tool').at(-1);
  expect(String(ran?.content).split('\n')).toContain(proj);
  expect(systemOf(model, 2)).toContain('PROJECT RULE 42');
  // The note, once, under the answer — not between the turn's rounds.
  const frame = ui.backend.lastFrame;
  expect(frame).toContain(`Project instructions: ${shown(path.join(proj, 'AGENTS.md'))}`);
  expect(frame.indexOf('Project instructions:')).toBeGreaterThan(frame.indexOf('In the project.'));
  expect(frame.split('Project instructions:').length - 1).toBe(1);

  // The next message is sent with the section too — it stays until the directory moves.
  model.script([{ text: 'Still here.' }]);
  await ui.type('and now?');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 4);
  expect(systemOf(model, 3)).toContain('PROJECT RULE 42');
  ui.app.unmount();
});

test('!cd moves into a project too; at the root, with no file there, no section and no note', async () => {
  const root = rootDir();
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'BANG RULE');
  const model = new ScriptedModel();
  const ui = await bootApp(model, 160, 32, undefined, { shell: { roots: [root] } });
  await ui.press('F');
  expect(ui.backend.lastFrame).not.toContain('Project instructions');
  await ui.type('!cd proj');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Project instructions:'));
  expect(ui.backend.lastFrame).toContain(`Project instructions: ${shown(path.join(proj, 'AGENTS.md'))}`);
  model.script([{ text: 'ok' }]);
  await ui.type('hi');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  expect(systemOf(model, 0)).toContain('BANG RULE');
  ui.app.unmount();
});

test('with no roots configured nothing is read, even where the process runs', async () => {
  // The process's own directory — this checkout — has an AGENTS.md; with no roots it is
  // outside them, and so never read.
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await bootApp(model, 120, 32);
  await ui.press('F');
  await ui.type('hi');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  expect(systemOf(model, 0)).not.toContain('## Project instructions');
  expect(ui.backend.lastFrame).not.toContain('Project instructions');
  ui.app.unmount();
});

test('a restored session is back in its project: the section is sent, and the note is said once across restarts', async () => {
  const root = rootDir();
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'RESTORED RULE');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-instr-sess-'));
  const cfg = { shell: { roots: [root] }, sessions: { dir } };
  const first = new ScriptedModel();
  first.script([{ tool: 'cd', args: { path: 'proj' } }], [{ text: 'In.' }]);
  const a = await bootApp(first, 160, 32, undefined, cfg);
  await a.press('F');
  await a.type('enter the project');
  await a.press('return');
  await settleUntil(() => a.backend.lastFrame.includes('Project instructions:'));
  await wait(350); // the debounced save
  a.app.unmount();

  for (let i = 0; i < 2; i++) {
    const model = new ScriptedModel();
    model.script([{ text: 'Yes.' }]);
    const b = await bootApp(model, 160, 32, undefined, cfg);
    await b.press('F');
    await settle(6);
    expect(b.backend.lastFrame.split('Project instructions:').length - 1).toBe(1);
    await b.type(`still there ${i}?`);
    await b.press('return');
    await settleUntil(() => model.requests.length === 1);
    expect(systemOf(model, 0)).toContain('RESTORED RULE');
    await wait(350);
    b.app.unmount();
  }
});

test('/clear goes back to the root and says which instructions the fresh conversation starts with', async () => {
  const root = rootDir();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'ROOT RULE');
  fs.mkdirSync(path.join(root, 'proj'));
  const model = new ScriptedModel();
  const ui = await bootApp(model, 160, 32, undefined, { shell: { roots: [root] } });
  await ui.press('F');
  await settleUntil(() => ui.backend.lastFrame.includes('Project instructions:'));
  expect(ui.backend.lastFrame).toContain(`Project instructions: ${shown(path.join(root, 'AGENTS.md'))}`);
  await ui.type('/clear');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain(`Project instructions: ${shown(path.join(root, 'AGENTS.md'))}`);
  ui.app.unmount();
});
