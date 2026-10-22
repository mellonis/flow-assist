// `/subagent @`: the agent files found, listed in the chat, completed after the `@`; a
// start by name is refused while it is not built. The real app on the scripted model.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostStateDir } from '../config/load.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(path.join(hostStateDir(), 'agents'), { recursive: true, force: true });
});

const doc = (description: string, header = '', body = 'do it') => `---\ndescription: ${description}\n${header}---\n${body}\n`;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

// A booted chat whose shell starts in a git project under a root (or with no roots).
async function chat(opts: { roots?: boolean; guests?: (make: any) => any[]; untrusted?: Array<{ name: string }> } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ag-')));
  made.push(root);
  fs.mkdirSync(path.join(root, '.git'));
  const model = new ScriptedModel();
  const extra = opts.roots === false ? {} : { shell: { roots: [root] } };
  const ui = await bootApp(model, 140, 40, opts.guests as never, extra, { toastMs: 10_000, startDir: root, untrusted: opts.untrusted as never });
  await ui.press('F');
  return { root, model, ui };
}

test('/subagent @ lists the agents with parameters and source, the shadowed ones, and the errors with path:line', async () => {
  const { root, ui } = await chat();
  write(path.join(root, '.flow-assist', 'agents', 'new-ticket.md'), doc('Start a ticket', 'params: ticket, branch?\n', 'Open {{ticket}} on {{branch}}'));
  write(path.join(root, '.flow-assist', 'agents', 'bad.md'), doc('Broken', 'tool: x\n'));
  write(path.join(hostStateDir(), 'agents', 'new-ticket.md'), doc('The person\'s ticket'));
  write(path.join(hostStateDir(), 'agents', 'notes.md'), doc('Take notes'));
  await ask(ui, '/subagent @');
  await settleUntil(() => frameOf(ui).includes('@notes'));
  const frame = frameOf(ui);
  expect(frame).toContain('@new-ticket — Start a ticket · <ticket> [branch] · project');
  expect(frame).toContain('@notes — Take notes · person');
  expect(frame).toContain('@new-ticket — The person\'s ticket · person (shadowed');
  expect(frame).toContain('shadowed by the project');
  expect(frame).toContain('bad.md:3: unknown key');
  expect(frame).not.toContain('@bad');
  ui.app.unmount();
});

test('with shell.roots unset the listing says the project\'s agents are not read', async () => {
  const { root, ui } = await chat({ roots: false });
  write(path.join(root, '.flow-assist', 'agents', 'proj.md'), doc('Project agent'));
  write(path.join(hostStateDir(), 'agents', 'mine.md'), doc('Mine'));
  await ask(ui, '/subagent @');
  await settleUntil(() => frameOf(ui).includes('@mine'));
  expect(frameOf(ui)).toContain('@mine — Mine');
  expect(frameOf(ui)).toContain('the project\'s agents are not read');
  expect(frameOf(ui)).not.toContain('Project agent');
  ui.app.unmount();
});

test('a plugin\'s agents are listed as <plugin>/<name>; an untrusted plugin\'s are not', async () => {
  const plug = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ag-plug-')));
  made.push(plug);
  write(path.join(plug, 'manifest.json'), JSON.stringify({ agents: ['a.md'] }));
  write(path.join(plug, 'a.md'), doc('From the plugin'));
  const guests = (make: any) => [
    Object.assign(make('agentplug', { name: 'agentplug' }), { dir: plug }),
  ];
  const { ui } = await chat({ guests });
  await ask(ui, '/subagent @');
  await settleUntil(() => frameOf(ui).includes('@agentplug/a'));
  expect(frameOf(ui)).toContain('@agentplug/a — From the plugin');
  expect(frameOf(ui)).toContain('plugin agentplug');
  (ui.site.untrusted as Array<{ name: string }>).push({ name: 'agentplug' });
  await ask(ui, '/subagent @');
  await settle(10);
  const after = frameOf(ui).split('@agentplug/a — From the plugin').length - 1;
  expect(after).toBe(1);
  ui.app.unmount();
});

test('bare /subagent still lists live work', async () => {
  const { root, ui } = await chat();
  write(path.join(root, '.flow-assist', 'agents', 'x.md'), doc('An agent'));
  await ask(ui, '/subagent');
  await settleUntil(() => frameOf(ui).includes('no subagents here'));
  expect(frameOf(ui)).toContain('no subagents here');
  expect(frameOf(ui)).not.toContain('An agent');
  ui.app.unmount();
});

test('Tab after /subagent @ completes an agent name', async () => {
  const { root, ui } = await chat();
  write(path.join(root, '.flow-assist', 'agents', 'zeta-job.md'), doc('Z'));
  write(path.join(hostStateDir(), 'agents', 'alpha-job.md'), doc('A'));
  await ui.type('/subagent @ze');
  await ui.press('tab');
  await settle(4);
  expect(frameOf(ui)).toContain('/subagent @zeta-job');
  ui.app.unmount();
});

test('/subagent @<name> … is refused while starting an agent is not available', async () => {
  const { root, ui } = await chat();
  write(path.join(root, '.flow-assist', 'agents', 'x.md'), doc('An agent'));
  await ask(ui, '/subagent @x do it');
  await settleUntil(() => frameOf(ui).includes('starting an agent is not available'));
  expect(frameOf(ui)).toContain('/subagent @x: starting an agent is not available');
  ui.app.unmount();
});
