// `/skill` through the real app on the scripted model: the listing, Tab, the trust y/n and
// what it records, and the person's load as one message (the body framed, then their text).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentTrustPath, skillChanged, skillTrusted } from '../assistant/agent-trust.ts';
import { loadSkillFresh } from '../assistant/skill-file.ts';
import { readJournal, exportMarkdown, type JournalEvent } from '../assistant/journal.ts';
import { hostStateDir } from '../config/load.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { listTree } from './helpers/session-files';

const made: string[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(path.join(hostStateDir(), 'skills'), { recursive: true, force: true });
  fs.rmSync(agentTrustPath(), { force: true });
});

const doc = (description: string, body = 'do it', extra = '') => `---\ndescription: ${description}\n${extra}---\n${body}\n`;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const lastUser = (model: ScriptedModel, at = -1): string => {
  const users = (model.requests.at(at)?.messages ?? []).filter((m) => m.role === 'user');
  return String(users.at(-1)?.content ?? '');
};

async function chat(opts: { guests?: (make: any) => unknown[]; cols?: number } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-skill-cmd-')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-skill-cmd-sessions-'));
  made.push(root, dir);
  fs.mkdirSync(path.join(root, '.git'));
  const model = new ScriptedModel();
  const extra = { sessions: { dir }, shell: { roots: [root] }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } };
  const ui = await bootApp(model, opts.cols ?? 200, 50, opts.guests as never, extra, { toastMs: 10_000, startDir: root });
  await ui.press('F');
  return { root, dir, model, ui, project: path.join(root, '.flow-assist', 'skills'), mine: path.join(hostStateDir(), 'skills') };
}
const project = (dir: string) => { const r = loadSkillFresh(dir, { kind: 'project' }); if (!r.ok) throw new Error('unreadable'); return r.skill; };
const person = (dir: string) => { const r = loadSkillFresh(dir, { kind: 'person' }); if (!r.ok) throw new Error('unreadable'); return r.skill; };

test('/skill lists name, description, source, trust, ignored keys, errors with path:line, and a shadowed one', async () => {
  const { ui, project: pdir, mine } = await chat();
  write(path.join(pdir, 'deploy', 'SKILL.md'), doc('Ships it', 'steps', 'allowed-tools: x\n'));
  write(path.join(mine, 'notes', 'SKILL.md'), doc('Takes notes'));
  write(path.join(mine, 'deploy', 'SKILL.md'), doc('My own deploy'));
  write(path.join(mine, 'broken', 'SKILL.md'), '---\nname: broken\n---\nbody\n');
  await ask(ui, '/skill');
  await settleUntil(() => frameOf(ui).includes('Takes notes'));
  const f = frameOf(ui);
  expect(f).toContain('/skill deploy — Ships it · project · not loaded yet');
  expect(f).toContain('ignored: allowed-tools');
  expect(f).toContain('/skill notes — Takes notes · person · not loaded yet');
  expect(f).toContain('not offered');
  expect(f).toContain('shadowed by the project');
  expect(f).toContain(`${path.join(mine, 'broken', 'SKILL.md')}:`);
  ui.app.unmount();
});

test('the listing says trusted after a load, and changed after an edit', async () => {
  const { model, ui, mine } = await chat();
  const dir = path.join(mine, 'notes');
  write(path.join(dir, 'SKILL.md'), doc('Takes notes'));
  model.script([{ text: 'ok' }]);
  await ask(ui, '/skill notes');
  await settleUntil(() => model.requests.length === 1);
  await settle(20);
  await ask(ui, '/skill');
  await settleUntil(() => frameOf(ui).includes('· trusted'));
  expect(frameOf(ui)).toContain('/skill notes — Takes notes · person · trusted');
  write(path.join(dir, 'SKILL.md'), doc('Takes notes', 'other body'));
  await ask(ui, '/skill');
  await settleUntil(() => frameOf(ui).includes('changed since you loaded it'));
  expect(frameOf(ui)).toContain('changed since you loaded it');
  ui.app.unmount();
});

test('Tab completes a skill name and the word trust', async () => {
  const { ui, mine } = await chat();
  write(path.join(mine, 'notes', 'SKILL.md'), doc('Takes notes'));
  write(path.join(mine, 'deploy', 'SKILL.md'), doc('Ships'));
  await ui.type('/skill no');
  await ui.press('tab');
  expect(frameOf(ui)).toContain('/skill notes');
  await ui.press('escape');
  await ui.type('/skill tr');
  await ui.press('tab');
  expect(frameOf(ui)).toContain('/skill trust');
  await ui.type(' ');
  await ui.type('dep');
  await ui.press('tab');
  expect(frameOf(ui)).toContain('/skill trust deploy');
  ui.app.unmount();
});

test('/skill trust shows source, path, file count and size; yes records the content, no records nothing, and nothing is sent', async () => {
  const { model, ui, project: pdir } = await chat();
  const dir = path.join(pdir, 'deploy');
  write(path.join(dir, 'SKILL.md'), doc('Ships it', 'steps'));
  write(path.join(dir, 'references', 'a.md'), 'x'.repeat(2000));
  await ask(ui, '/skill trust deploy');
  await settleUntil(() => frameOf(ui).includes('(y/n)'));
  const f = frameOf(ui);
  expect(f).toContain('skill «deploy» is a project skill you have not loaded — trust it? (y/n)');
  expect(f).toContain('source: project');
  expect(f).toContain(`path: ${path.join(dir, 'SKILL.md')}`);
  expect(f).toContain('2 files, 2 KB');
  expect(skillTrusted(project(dir))).toBe(false);
  await ui.press('n');
  await settleUntil(() => frameOf(ui).includes('was not trusted'));
  expect(skillTrusted(project(dir))).toBe(false);
  await ask(ui, '/skill trust deploy');
  await settleUntil(() => frameOf(ui).includes('(y/n)'));
  await ui.press('y');
  await settleUntil(() => skillTrusted(project(dir)));
  expect(skillTrusted(project(dir))).toBe(true);
  await settle(20);
  expect(model.requests.length).toBe(0);
  ui.app.unmount();
});

test('/skill <name> text on a project skill asks first; yes sends the framed body then the text and records; the next one asks nothing', async () => {
  const { model, ui, project: pdir } = await chat();
  const dir = path.join(pdir, 'deploy');
  write(path.join(dir, 'SKILL.md'), doc('Ships it', 'SHIP-STEPS go'));
  model.script([{ text: 'one' }], [{ text: 'two' }]);
  await ask(ui, '/skill deploy to staging please');
  await settleUntil(() => frameOf(ui).includes('(y/n)'));
  expect(frameOf(ui)).toContain('load it? (y/n)');
  expect(model.requests.length).toBe(0);
  await ui.press('y');
  await settleUntil(() => model.requests.length === 1);
  const sent = lastUser(model);
  expect(sent).toMatch(/^\[The skill «deploy» — project, .*SKILL\.md, content [0-9a-f]{12} — instructions for this task/);
  expect(sent).toMatch(/<skill n=([0-9a-f]{8}) name=deploy>\nSHIP-STEPS go\n<\/skill n=\1>\n\nto staging please$/);
  expect(skillTrusted(project(dir))).toBe(true);
  // The screen shows the line, not the body.
  await settleUntil(() => frameOf(ui).includes('one'));
  expect(frameOf(ui)).toContain('/skill deploy to staging please');
  expect(frameOf(ui)).not.toContain('SHIP-STEPS');
  await ask(ui, '/skill deploy');
  await settleUntil(() => model.requests.length === 2);
  expect(frameOf(ui)).not.toContain('(y/n)');
  expect(lastUser(model)).toEndWith('\n\napply this skill');
  ui.app.unmount();
});

test('a changed project skill asks again and says it changed', async () => {
  const { model, ui, project: pdir } = await chat();
  const dir = path.join(pdir, 'deploy');
  write(path.join(dir, 'SKILL.md'), doc('Ships it', 'v1'));
  model.script([{ text: 'a' }], [{ text: 'b' }]);
  await ask(ui, '/skill deploy');
  await settleUntil(() => frameOf(ui).includes('(y/n)'));
  await ui.press('y');
  await settleUntil(() => model.requests.length === 1);
  await settleUntil(() => frameOf(ui).includes('a'));
  write(path.join(dir, 'references.md'), 'a file beside it changes the directory too');
  expect(skillChanged(project(dir))).toBe(true);
  await ask(ui, '/skill deploy');
  await settleUntil(() => frameOf(ui).includes('changed since you last loaded it'));
  expect(model.requests.length).toBe(1);
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  ui.app.unmount();
});

test('Esc on the y/n sends nothing, records nothing and keeps the line in the field', async () => {
  const { model, ui, project: pdir } = await chat();
  const dir = path.join(pdir, 'deploy');
  write(path.join(dir, 'SKILL.md'), doc('Ships it', 'v1'));
  await ask(ui, '/skill deploy to staging');
  await settleUntil(() => frameOf(ui).includes('(y/n)'));
  await ui.press('escape');
  await settleUntil(() => !frameOf(ui).includes('(y/n)'));
  await settle(10);
  expect(frameOf(ui)).toContain('/skill deploy to staging');
  expect(model.requests.length).toBe(0);
  expect(skillTrusted(project(dir))).toBe(false);
  ui.app.unmount();
});

test('content that changed while the person was asked is not recorded and not sent', async () => {
  const { model, ui, project: pdir } = await chat();
  const dir = path.join(pdir, 'deploy');
  write(path.join(dir, 'SKILL.md'), doc('Ships it', 'v1'));
  await ask(ui, '/skill deploy');
  await settleUntil(() => frameOf(ui).includes('(y/n)'));
  write(path.join(dir, 'SKILL.md'), doc('Ships it', 'v2 — rewritten by a command while the question stood'));
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('changed while you were asked'));
  expect(frameOf(ui)).toContain('changed while you were asked');
  expect(skillTrusted(project(dir))).toBe(false);
  expect(model.requests.length).toBe(0);
  ui.app.unmount();
});

test('a person\'s own skill is recorded at the first load without a question', async () => {
  const { model, ui, mine } = await chat();
  const dir = path.join(mine, 'notes');
  write(path.join(dir, 'SKILL.md'), doc('Takes notes', 'NOTE-STEPS'));
  model.script([{ text: 'ok' }]);
  expect(skillTrusted(person(dir))).toBe(false);
  await ask(ui, '/skill notes');
  await settleUntil(() => model.requests.length === 1);
  expect(frameOf(ui)).not.toContain('(y/n)');
  expect(lastUser(model)).toContain('NOTE-STEPS');
  expect(skillTrusted(person(dir))).toBe(true);
  ui.app.unmount();
});

test('a plugin\'s skill loads with no question and no record', async () => {
  const plug = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-skill-plug-')));
  made.push(plug);
  write(path.join(plug, 'manifest.json'), JSON.stringify({ skills: ['ticket'] }));
  write(path.join(plug, 'ticket', 'SKILL.md'), doc('Files tickets', 'PLUG-STEPS'));
  const { model, ui } = await chat({ guests: (make) => [Object.assign(make('skillplug', { name: 'skillplug' }), { dir: plug })] });
  model.script([{ text: 'ok' }]);
  const before = fs.existsSync(agentTrustPath()) ? fs.readFileSync(agentTrustPath(), 'utf8') : null;
  await ask(ui, '/skill skillplug/ticket go');
  await settleUntil(() => model.requests.length === 1);
  expect(frameOf(ui)).not.toContain('(y/n)');
  expect(lastUser(model)).toContain('PLUG-STEPS');
  expect(lastUser(model)).toContain('plugin skillplug');
  expect(fs.existsSync(agentTrustPath()) ? fs.readFileSync(agentTrustPath(), 'utf8') : null).toBe(before);
  ui.app.unmount();
});

test('an unknown name is an error on the field, nothing is sent', async () => {
  const { model, ui } = await chat();
  await ask(ui, '/skill nothing here');
  await settleUntil(() => frameOf(ui).includes('/skill nothing'));
  expect(frameOf(ui)).toContain('/skill nothing');
  await settle(10);
  expect(model.requests.length).toBe(0);
  ui.app.unmount();
});

test('the journal records skill-load by the person with the content hash; /export shows the line, not the body', async () => {
  const { model, ui, dir: sessions, root, mine } = await chat();
  const dir = path.join(mine, 'notes');
  write(path.join(dir, 'SKILL.md'), doc('Takes notes', 'NOTE-STEPS'));
  model.script([{ text: 'ok' }]);
  await ask(ui, '/skill notes for the standup');
  await settleUntil(() => model.requests.length === 1);
  await settle(30);
  const log = listTree(sessions).find((n) => n.endsWith('.log.jsonl'))!;
  const events = readJournal(path.join(sessions, log)) as JournalEvent[];
  const load = events.filter((e) => e.t === 'skill-load');
  expect(load).toHaveLength(1);
  expect(load[0]).toMatchObject({ name: 'notes', source: 'person', path: path.join(fs.realpathSync(dir), 'SKILL.md'), hash: person(dir).hash, by: 'person' });
  const row = events.find((e) => e.t === 'row' && e.role === 'user');
  expect(row?.text).toBe('/skill notes for the standup');
  await ask(ui, '/export out.md');
  await settleUntil(() => fs.existsSync(path.join(root, 'out.md')));
  const md = fs.readFileSync(path.join(root, 'out.md'), 'utf8');
  expect(md).toContain('/skill notes for the standup');
  expect(md).toContain('Skill «notes» loaded by you (person');
  expect(md).not.toContain('NOTE-STEPS');
  expect(exportMarkdown(events, { title: 't', id: 'x' })).toContain(`content ${person(dir).hash.slice(0, 12)}`);
  ui.app.unmount();
});

test('while an answer is coming /skill is refused and the line stays: it is not queued as a message', async () => {
  const { model, ui, mine } = await chat();
  write(path.join(mine, 'notes', 'SKILL.md'), doc('Takes notes', 'NOTE-STEPS'));
  model.script([{ hold: true }, { text: 'done' }]);
  await ask(ui, 'first question');
  await settleUntil(() => model.requests.length === 1);
  await ask(ui, '/skill notes');
  await settleUntil(() => frameOf(ui).includes('an answer is coming'));
  expect(frameOf(ui)).toContain('/skill: an answer is coming');
  expect(frameOf(ui)).toContain('/skill notes');
  model.release();
  await settleUntil(() => frameOf(ui).includes('done'));
  await settle(20);
  expect(model.requests.length).toBe(1);
  ui.app.unmount();
});
