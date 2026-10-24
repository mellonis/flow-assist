// An agent file's `skills:` key on the person's path (`/subagent @name`): the same
// resolution as the model's start, the failure before anything is asked or recorded, the
// bodies in the child's first message, the start note and the journal. The real app on
// the scripted model.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentHash, parseAgentFile } from '../assistant/agent-file.ts';
import { agentTrusted, agentTrustPath, recordAgentStart, skillKeyOf } from '../assistant/agent-trust.ts';
import { readJournal, type JournalEvent } from '../assistant/journal.ts';
import { loadSkillFresh } from '../assistant/skill-file.ts';
import { hostStateDir } from '../config/load.ts';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';
import { listTree } from './helpers/session-files';

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(path.join(hostStateDir(), 'skills'), { recursive: true, force: true });
  fs.rmSync(agentTrustPath(), { force: true });
});

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

async function chat(mark: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sk-ag-')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sk-ag-sessions-'));
  made.push(root, dir);
  fs.mkdirSync(path.join(root, '.git'));
  const model = new ScriptedModel();
  const child = model.when((req) => firstUser(req).includes(mark));
  const extra = { sessions: { dir }, shell: { roots: [root] }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } };
  const ui = await bootApp(model, 140, 40, (make) => [make('guest', { tools: [] })] as never[], extra, { toastMs: 10_000, startDir: root });
  await ui.press('F');
  return { root, dir, model, child, ui, agents: path.join(root, '.flow-assist', 'agents') };
}
// A person's skill, recorded as the person's first use leaves it (or not).
function person(name: string, body: string, recorded = true): void {
  const dir = path.dirname(write(path.join(hostStateDir(), 'skills', name, 'SKILL.md'), `---\ndescription: ${name} words\n---\n${body}\n`));
  if (!recorded) return;
  const fresh = loadSkillFresh(dir, { kind: 'person' });
  if (!fresh.ok) throw new Error('unreadable');
  let files: Record<string, string> = {};
  try { files = (JSON.parse(fs.readFileSync(agentTrustPath(), 'utf8')) as { files: Record<string, string> }).files; } catch { /* none yet */ }
  files[skillKeyOf(fresh.skill)] = fresh.skill.hash;
  write(agentTrustPath(), JSON.stringify({ files }));
}
const agentDoc = (header: string, body: string) => `---\ndescription: A test agent\n${header}---\n${body}\n`;

test('the person\'s start loads the named skills after the prompt in order, notes them, journals each as loaded by the agent, and records the file', async () => {
  const { agents, dir, child, ui } = await chat('GO-P');
  person('alpha', 'ALPHA-BODY');
  person('beta', 'BETA-BODY');
  const text = agentDoc('params: ticket\nskills: beta, alpha\n', 'GO-P {{ticket}}');
  const file = write(path.join(agents, 'job.md'), text);
  recordAgentStart({ path: file, source: { kind: 'project' }, hash: agentHash(text) });
  child.script([{ text: 'ok' }]);
  await ask(ui, '/subagent @job T-1');
  await settleUntil(() => child.requests.length === 1);
  const first = firstUser(child.requests[0]!);
  expect(first.startsWith('GO-P T-1\n\n[The skill «beta» — person, ')).toBe(true);
  expect(first.indexOf('BETA-BODY')).toBeLessThan(first.indexOf('«alpha»'));
  expect(first).toContain('ALPHA-BODY');
  expect(((child.requests[0]!.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name)).toContain('skill');
  await settleUntil(() => frameOf(ui).includes('skills preloaded'));
  expect(frameOf(ui)).toContain('@job: skills preloaded — beta, alpha');
  const parent = listTree(dir).filter((n) => n.endsWith('.log.jsonl') && !n.includes('.sub'))[0]!;
  const loads = (readJournal(path.join(dir, parent)) as JournalEvent[]).filter((e) => e.t === 'skill-load');
  expect(loads.map((e) => [e.name, e.by, e.agent])).toEqual([['beta', 'agent', 'job'], ['alpha', 'agent', 'job']]);
  ui.app.unmount();
});

test('a skill that is not trusted fails the start before any question: the skill and the command are named, nothing starts, the file is not recorded, the line stays', async () => {
  const { agents, child, model, ui } = await chat('GO-U');
  person('secret', 'S', false);
  const file = write(path.join(agents, 'job.md'), agentDoc('skills: secret\n', 'GO-U go'));
  await ask(ui, '/subagent @job');
  await settleUntil(() => frameOf(ui).includes('run /skill secret once'));
  expect(frameOf(ui)).toContain('@job: the skill «secret» is not trusted');
  expect(frameOf(ui)).toContain('ask the person to run /skill secret once');
  expect(frameOf(ui)).not.toContain('(y/n)');
  expect(frameOf(ui)).toContain('/subagent @job');
  await settle(10);
  expect(child.requests).toHaveLength(0);
  expect(model.requests).toHaveLength(0);
  const r = parseAgentFile(file, fs.readFileSync(file), { kind: 'project' });
  expect(r.ok && agentTrusted(r.agent)).toBe(false);
  ui.app.unmount();
});

test('a missing skill fails the start too', async () => {
  const { agents, child, ui } = await chat('GO-X');
  write(path.join(agents, 'job.md'), agentDoc('skills: ghost\n', 'GO-X go'));
  await ask(ui, '/subagent @job');
  await settleUntil(() => frameOf(ui).includes('no skill named ghost'));
  expect(frameOf(ui)).toContain('@job names the skill «ghost»: no skill named ghost');
  await settle(10);
  expect(child.requests).toHaveLength(0);
  ui.app.unmount();
});

test('a project agent\'s first-start question lists its skills', async () => {
  const { agents, child, ui } = await chat('GO-Q');
  person('alpha', 'A');
  write(path.join(agents, 'job.md'), agentDoc('skills: alpha\n', 'GO-Q go'));
  child.script([{ text: 'ok' }]);
  await ask(ui, '/subagent @job');
  await settleUntil(() => frameOf(ui).includes('(y/n)'));
  expect(frameOf(ui)).toContain('skills: alpha (loaded into its first message)');
  await ui.press('y');
  await settleUntil(() => child.requests.length === 1);
  expect(firstUser(child.requests[0]!)).toContain('The skill «alpha»');
  ui.app.unmount();
});

test('the skills are read again after the first-start question: a skill changed while it was open fails the start', async () => {
  const { agents, child, ui } = await chat('GO-R');
  person('alpha', 'A-ONE');
  write(path.join(agents, 'job.md'), agentDoc('skills: alpha\n', 'GO-R go'));
  child.script([{ text: 'ok' }]);
  await ask(ui, '/subagent @job');
  await settleUntil(() => frameOf(ui).includes('(y/n)'));
  write(path.join(hostStateDir(), 'skills', 'alpha', 'SKILL.md'), '---\ndescription: alpha words\n---\nA-TWO\n');
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('run /skill alpha once'));
  expect(frameOf(ui)).toContain('the skill «alpha» is not trusted');
  await settle(10);
  expect(child.requests).toHaveLength(0);
  ui.app.unmount();
});
