// The person's `/skill` message and what keeps a loaded skill in the conversation: the
// body exempt from the recall stub and the tool-result cut, the compaction summary that
// names the skills loaded, and the size a file beside a skill is cut at.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { agentTrustPath, recordSkillLoad } from '../assistant/agent-trust.ts';
import { loadSkillFresh } from '../assistant/skill-file.ts';
import { frameSkill, SKILLS_LINE } from '../assistant/skill-model.ts';
import { hostStateDir } from '../config/load.ts';
import { ScriptedModel, handoff } from './helpers/scripted';
import { closeRigs, conversationRig } from './helpers/conversation';

afterEach(() => {
  closeRigs();
  fs.rmSync(path.join(hostStateDir(), 'skills'), { recursive: true, force: true });
  fs.rmSync(agentTrustPath(), { force: true });
});

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const BULKY = { type: 'function' as const, function: { name: 'bulky_look', description: 'Returns a lot.', parameters: { type: 'object', properties: {} } } };

function person(name: string, body: string, extra: Record<string, string> = {}) {
  const dir = path.dirname(write(path.join(hostStateDir(), 'skills', name, 'SKILL.md'), `---\ndescription: ${name} words\n---\n${body}\n`));
  for (const [rel, text] of Object.entries(extra)) write(path.join(dir, rel), text);
  const r = loadSkillFresh(dir, { kind: 'person' });
  if (!r.ok) throw new Error('unreadable');
  recordSkillLoad({ ...r.skill, source: r.skill.source });
  return { ...r.skill, id: name };
}
// What the chat sends for `/skill <name> <text>`.
const loadOf = (skill: ReturnType<typeof person>, text = 'apply this skill') => ({
  skill: { id: skill.id, source: skill.source.kind, path: skill.path, hash: skill.hash, framed: `${frameSkill(skill, skill.body)}\n\n${text}` },
});
function rigOf(ai: Record<string, unknown> = {}) {
  const model = new ScriptedModel();
  const rig = conversationRig(model, {
    ai: { backgroundFollowUp: false, ...ai },
    guests: (make) => [make('guest', { tools: [{ id: 'bulk', tools: [BULKY], exec: async () => 'z'.repeat(3000) }] }) as never],
  });
  return { model, rig };
}

test('the person\'s load is one message: the model reads the framed body then the text, the row and the journal keep the typed line', async () => {
  const { model, rig } = rigOf();
  const skill = person('notes', 'WRITE-IT-DOWN');
  model.script([{ text: 'ok' }]);
  await rig.conv.send('/skill notes for today', loadOf(skill, 'for today'));
  await rig.idle();
  const last = String(rig.sent(0).at(-1)!.content);
  expect(last).toMatch(/^\[The skill «notes» — person, .*SKILL\.md, content [0-9a-f]{12} — /);
  expect(last).toMatch(/<skill n=([0-9a-f]{8}) name=notes>\nWRITE-IT-DOWN\n<\/skill n=\1>\n\nfor today$/);
  expect(rig.conv.rows().filter((m) => m.role === 'user').map((m) => String(m.content))).toEqual(['/skill notes for today']);
  const events = rig.journal();
  expect(events.find((e) => e.t === 'row' && e.role === 'user')).toMatchObject({ text: '/skill notes for today' });
  expect(events.filter((e) => e.t === 'skill-load')).toEqual([expect.objectContaining({ name: 'notes', source: 'person', path: skill.path, hash: skill.hash, by: 'person' })]);
  // An ordinary message writes none.
  await rig.conv.send('and then?');
  expect(rig.journal().filter((e) => e.t === 'skill-load')).toHaveLength(1);
});

test('the person\'s body is not stubbed by a recall batch that stubs an ordinary bulky result, and not cut by the tool-result cap', async () => {
  const { model, rig } = rigOf({ toolResultMaxChars: 500, recall: { minChars: 200 } });
  const skill = person('notes', 'w'.repeat(2500));
  model.script([{ tool: 'bulky_look', args: {} }], [{ text: 'ok' }], [{ text: 'again' }]);
  await rig.conv.send('/skill notes', loadOf(skill));
  await rig.idle();
  const items = rig.conv.recallItems();
  expect(items).toHaveLength(1);
  rig.conv.recall.stubbed = new Set(items.map((i) => i.id));
  await rig.conv.send('go on');
  await rig.idle();
  const sent = JSON.stringify(rig.sent());
  expect(sent).toContain('w'.repeat(2500));
  expect(sent).not.toContain('z'.repeat(3000));
  expect(sent).toContain('bulky_look');
});

test('a compaction names the skills loaded — the person\'s and the model\'s — after the summary, and a later one carries them on', async () => {
  const { model, rig } = rigOf();
  const mine = person('notes', 'N-BODY');
  person('deploy', 'D-BODY');
  model.script([{ text: 'one' }], [{ tool: 'skill', args: { name: 'deploy' } }], [{ text: 'two' }], [{ text: handoff('FIRST') }], [{ text: 'three' }], [{ text: `${handoff('SECOND')}\n${SKILLS_LINE} invented` }]);
  await rig.conv.send('/skill notes', loadOf(mine));
  await rig.idle();
  await rig.conv.send('now deploy');
  await rig.idle();
  rig.conv.compact();
  await rig.idle();
  expect(rig.conv.summary).toBe(`${handoff('FIRST')}\n\n${SKILLS_LINE} deploy, notes`);
  expect(SKILLS_LINE).toContain('load each again with the skill tool');
  // The next request carries it in the system context; the bodies went with the history.
  await rig.conv.send('three');
  await rig.idle();
  const sys = String(rig.messages(-1).find((m) => m.role === 'system')?.content);
  expect(sys).toContain(`${SKILLS_LINE} deploy, notes`);
  expect(JSON.stringify(rig.sent())).not.toContain('N-BODY');
  // A second compaction, with no skill left in the history: the line stays, the model's own is replaced.
  rig.conv.compact();
  await rig.idle();
  expect(rig.conv.summary).toBe(`${handoff('SECOND')}\n\n${SKILLS_LINE} deploy, notes`);
});

test('a conversation that loaded no skill gets no skills line', async () => {
  const { model, rig } = rigOf();
  model.script([{ text: 'one' }], [{ text: handoff('PLAIN') }]);
  await rig.conv.send('hello');
  rig.conv.compact();
  await rig.idle();
  expect(rig.conv.summary).toBe(handoff('PLAIN'));
});

test('a file beside a skill is cut at 40 000 characters when the tool-result limit is higher', async () => {
  const { model, rig } = rigOf({ toolResultMaxChars: 80_000, recall: { enabled: false } });
  person('notes', 'body', { 'big.txt': 'y'.repeat(60_000) });
  model.script([{ tool: 'skill', args: { name: 'notes', file: 'big.txt' } }], [{ text: 'ok' }]);
  await rig.conv.send('go');
  await rig.idle();
  const tool = String(rig.messages(1).find((m) => m.role === 'tool')?.content);
  expect(tool).toContain('y'.repeat(40_000));
  expect(tool).not.toContain('y'.repeat(40_001));
  expect(tool).toContain('… [cut: 60000 characters in all]');
});
