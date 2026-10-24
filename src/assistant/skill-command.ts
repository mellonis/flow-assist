// `/skill`: what the person's line means, how the skills read as a listing, and what the
// person is asked before a project skill is loaded or trusted. Pure text in, text out; the
// chat resolves, asks, records and sends.
import type { FoundSkill, FoundSkills } from './skill-find.js';
import type { Skill } from './skill-file.js';
import { formatBytes } from './session-picker.js';

export type SkillLine =
  | { kind: 'list' }
  | { kind: 'trust'; name: string }
  | { kind: 'load'; name: string; text: string }
  | { kind: 'error'; text: string };

// The rest of the line after `/skill` as the person typed it: the first word is a skill's
// name (`<plugin>/<name>` for a plugin's), what follows it is the text that goes with the
// body, its spacing and line breaks kept. `trust` as the first word is the command that
// records a skill without loading it (a skill of that name is loaded another way: by its
// plugin's prefix).
export function parseSkillLine(raw: string): SkillLine {
  const rest = raw.trim();
  if (!rest) return { kind: 'list' };
  const trust = /^trust(?:\s+([\s\S]*))?$/.exec(rest);
  if (trust) {
    const name = (trust[1] ?? '').trim();
    if (!name || /\s/.test(name)) return { kind: 'error', text: '/skill trust takes one skill name — /skill lists them' };
    return { kind: 'trust', name };
  }
  const at = rest.search(/\s/);
  return at < 0 ? { kind: 'load', name: rest, text: '' } : { kind: 'load', name: rest.slice(0, at), text: rest.slice(at).trim() };
}

// What the body is sent with when the person gives no text.
export const SKILL_DEFAULT_TEXT = 'apply this skill';

// The screen's and the journal's form of the person's line: what they typed, with the
// default text left out (it is the host's, not theirs).
export const skillTyped = (id: string, text: string): string => (text ? `/skill ${id} ${text}` : `/skill ${id}`);

export type SkillState = 'trusted' | 'changed' | 'new' | 'plugin';

const sourceText = (s: Pick<Skill, 'source'> & { plugin?: string | null }): string =>
  s.source.kind === 'plugin' ? `plugin ${s.plugin ?? s.source.plugin ?? ''}`.trim() : s.source.kind;

const STATE_TEXT: Record<SkillState, string> = {
  trusted: 'trusted',
  changed: 'changed since you loaded it — /skill <name> asks again',
  new: 'not loaded yet — /skill <name> or /skill trust <name>',
  plugin: 'trusted with its plugin',
};

// The skills found, as a note. A note is drawn as markdown, where single line breaks join,
// so each skill and each error is a list item: the skill with its description, where it
// comes from, whether the model may load it, and the header keys that are read and
// ignored; a person's skill hidden by the project's marked; every file with errors as
// `path:line: message`. With `shell.roots` unset it says the project's skills are not read.
export function skillListing(found: FoundSkills, stateOf: (s: FoundSkill) => SkillState): string {
  const item = (s: FoundSkill, extra = ''): string => {
    const notes = s.notes.length ? ` · ignored: ${s.notes.join(', ')}` : '';
    return `- /skill ${s.id} — ${s.description} · ${sourceText(s)} · ${s.shadowed ? 'not offered' : STATE_TEXT[stateOf(s)].replaceAll('<name>', s.id)}${notes}${extra}`;
  };
  const blocks: string[] = [];
  const skills = [...found.skills.map((s) => item(s)), ...found.shadowed.map((s) => item(s, ' (shadowed by the project\'s skill of this name)'))];
  blocks.push(skills.length ? skills.join('\n') : 'no skills found');
  if (found.errors.length) blocks.push(found.errors.map((e) => `- ${e.path}:${e.line}: ${e.message}`).join('\n'));
  if (!found.projectRead) blocks.push('the project\'s skills are not read — shell.roots is not set');
  return blocks.join('\n\n');
}

// What the person is asked before a project skill is loaded (`trust` false) or recorded
// without loading (`trust` true): where it is, how many files and how much, and what
// the answer does.
export function skillTrustRequest(skill: Pick<Skill, 'description' | 'path' | 'files' | 'bytes'>, id: string, changed: boolean, trust: boolean): { title: string; line: string; hint: string } {
  const verb = trust ? 'trust it' : 'load it';
  return {
    title: `⚠ ${changed ? `skill «${id}» changed since you last loaded it` : `skill «${id}» is a project skill you have not loaded`} — ${verb}? (y/n)`,
    line: [
      `${id} — ${skill.description}`,
      'source: project',
      `path: ${skill.path}`,
      `${skill.files} file${skill.files === 1 ? '' : 's'}, ${formatBytes(skill.bytes)}`,
    ].join('\n'),
    hint: trust ? 'y lets the model load this content · n records nothing · Esc keeps the line' : 'y sends it and lets the model load this content · n sends nothing · Esc keeps the line',
  };
}
