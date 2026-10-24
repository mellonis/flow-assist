// The skills an agent file names in its `skills:` key, resolved when the agent starts: the
// same rule as the model's own `skill` tool (a project or person skill must be recorded at
// its current content, a plugin's follows the plugin), each body read fresh and framed. A
// skill that is missing, broken or not trusted fails the start and says which. The text
// goes after the agent's prompt, in the order the file names them.
import { skillTrusted } from './agent-trust.js';
import { loadSkillFresh } from './skill-file.js';
import { resolveSkill, type FoundSkill, type FoundSkills } from './skill-find.js';
import { frameSkill } from './skill-model.js';

// One preloaded skill as the child and the journal record it.
export interface PreloadedSkill { id: string; source: string; path: string; hash: string }
export type Preload = { ok: true; skills: PreloadedSkill[]; text: string } | { ok: false; message: string };

// The framed text of all the skills together is at most this many characters.
export const PRELOAD_MAX_CHARS = 64 * 1024;

export function preloadSkills(names: readonly string[], agentId: string, finder: () => FoundSkills): Preload {
  if (!names.length) return { ok: true, skills: [], text: '' };
  let found: FoundSkills;
  try { found = finder(); } catch { return { ok: false, message: `@${agentId} names skills, and the skills cannot be read now` }; }
  const skills: PreloadedSkill[] = [];
  const framed: string[] = [];
  let total = 0;
  for (const name of names) {
    const hit = resolveSkill(name, found);
    if (!hit.ok) return { ok: false, message: `@${agentId} names the skill «${name}»: ${hit.message}` };
    const listed = hit.skill;
    const fresh = loadSkillFresh(listed.dir, listed.source, listed.name);
    // Unreadable now and not recorded answer in the same words, and never echo the files.
    const refusal = `@${agentId}: the skill «${listed.id}» is not trusted (new or changed) — ask the person to run /skill ${listed.id} once`;
    if (!fresh.ok) return { ok: false, message: refusal };
    const skill: FoundSkill = { ...listed, ...fresh.skill };
    if (!skillTrusted(skill)) return { ok: false, message: refusal };
    const frame = frameSkill(skill, skill.body);
    total += frame.length + 2;
    if (total > PRELOAD_MAX_CHARS) return { ok: false, message: `@${agentId}: the skill «${skill.id}» takes the preload past ${PRELOAD_MAX_CHARS / 1024} KiB — name fewer or smaller skills` };
    skills.push({ id: skill.id, source: skill.source.kind, path: skill.path, hash: skill.hash });
    framed.push(frame);
  }
  return { ok: true, skills, text: framed.join('\n\n') };
}

// The prompt with the skills' text after it.
export const withPreload = (prompt: string, text: string): string => (text ? `${prompt}\n\n${text}` : prompt);

// What a start says of them.
export const preloadNote = (agentId: string, skills: readonly PreloadedSkill[]): string =>
  skills.length ? `@${agentId}: skills preloaded — ${skills.map((s) => s.id).join(', ')}` : '';
