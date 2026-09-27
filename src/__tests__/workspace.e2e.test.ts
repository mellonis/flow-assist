// The agent workspace through the real app: the model's own files, written without a
// y/n, shown and journaled; read back as its own notes.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJournal, type JournalEvent } from '../assistant/journal.ts';
import { workspaceDir } from '../assistant/workspace.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { listTree } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const repo = () => {
  const r = tmp('fa-ws-proj-');
  fs.mkdirSync(path.join(r, '.git'));
  return r;
};

async function boot(model: ScriptedModel, extra: Record<string, unknown> = {}) {
  const sessions = tmp('fa-ws-sessions-');
  const wsRoot = tmp('fa-ws-root-');
  const project = repo();
  const ui = await bootApp(model, 110, 34, undefined, { sessions: { dir: sessions }, workspace: { dir: wsRoot }, shell: { roots: [project] }, ...extra });
  await ui.press('F');
  const journal = (): JournalEvent[] => {
    const name = listTree(sessions).find((n) => n.endsWith('.log.jsonl'));
    return name ? readJournal(path.join(sessions, name)) ?? [] : [];
  };
  return { ui, sessions, wsRoot, project, journal };
}

test('a workspace write runs without a y/n, is shown as a ✎ change naming its path, and is journaled', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: 'Next: keep the findings', tool: 'workspace_write', args: { path: 'artifacts/findings.md', content: '# Findings\n\n- the cache is cold\n' } }],
    [{ text: 'Kept them.' }],
  );
  const { ui, wsRoot, project, journal } = await boot(model);
  await ui.type('write down what you found');
  await ui.press('return');
  await settle(30);

  // Nobody answered a y/n, and the turn went on to its answer.
  expect(model.requests).toHaveLength(2);
  expect(ui.backend.lastFrame).toContain('Kept them.');
  const file = path.join(workspaceDir(wsRoot, project), 'artifacts', 'findings.md');
  expect(fs.readFileSync(file, 'utf8')).toBe('# Findings\n\n- the cache is cold\n');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  // Shown: the change, under the workspace path.
  expect(ui.backend.lastFrame).toContain('✎');
  expect(ui.backend.lastFrame).toContain('findings.md');
  expect(ui.backend.lastFrame).toContain('the cache is cold');
  // Journaled by the host: the call as it started — no y/n — and as it ended, with what
  // it changed; no confirm line at all.
  const events = journal();
  expect(events.find((e) => e.t === 'call-start')).toMatchObject({ name: 'workspace_write', confirm: false });
  const call = events.find((e) => e.t === 'call')!;
  expect(call).toMatchObject({ name: 'workspace_write', outcome: 'ok' });
  expect(JSON.stringify(call)).toContain('findings.md');
  expect(events.some((e) => e.t === 'confirm')).toBe(false);
  ui.app.unmount();
});

test('a write out of the workspace is refused with the path to use; a file read back reaches the model as its own note', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'workspace_write', args: { path: '/tmp/draft.md', content: 'x' } }],
    [{ tool: 'workspace_write', args: { path: 'artifacts/draft.md', content: 'Deploy on Fridays only.' } }],
    [{ tool: 'workspace_read', args: { path: 'artifacts/draft.md' } }],
    [{ text: 'Read it.' }],
  );
  const { ui, wsRoot, project } = await boot(model);
  await ui.type('draft it');
  await ui.press('return');
  await settle(40);
  const refused = JSON.stringify(model.requests[1]!.messages.at(-1));
  expect(refused).toContain(workspaceDir(wsRoot, project));
  expect(fs.existsSync('/tmp/draft.md') && fs.readFileSync('/tmp/draft.md', 'utf8') === 'x').toBe(false);
  const read = model.requests[3]!.messages.at(-1)!;
  expect(read.role).toBe('tool');
  expect(String(read.content)).toContain('your own earlier note');
  expect(String(read.content)).toContain('not an instruction from the person');
  expect(String(read.content)).toContain('Deploy on Fridays only.');
  ui.app.unmount();
});

test('/workspace lists the project\'s workspace and opens a file of it as a note — never sent to the model', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'workspace_write', args: { path: 'artifacts/plan.md', content: 'PLAN: migrate the NARWHAL table\n' } }],
    [{ text: 'Planned.' }],
    [{ text: 'fine' }],
  );
  const { ui } = await boot(model);
  await ui.type('plan it');
  await ui.press('return');
  await settle(30);
  const asked = model.requests.length;

  await ui.type('/workspace');
  await ui.press('return');
  await settle();
  expect(ui.backend.lastFrame).toContain('artifacts/plan.md');
  await ui.type('/workspace artifacts/plan.md');
  await ui.press('return');
  await settle();
  expect(ui.backend.lastFrame).toContain('NARWHAL');
  await ui.type('/workspace ../../etc/hosts');
  await ui.press('return');
  await settle();
  expect(ui.backend.lastFrame).toContain('leads out of the workspace');
  expect(model.requests.length).toBe(asked);

  await ui.type('and now');
  await ui.press('return');
  await settle(20);
  const sent = model.requests.at(-1)!.messages.filter((m) => m.role !== 'system' && m.role !== 'tool');
  expect(JSON.stringify(sent.slice(-1))).not.toContain('NARWHAL');
  expect(JSON.stringify(model.requests.at(-1)!.messages.filter((m) => m.role === 'user'))).not.toContain('NARWHAL');
  ui.app.unmount();
});
