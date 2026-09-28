import { expect, test } from 'bun:test';
import { STOPPED_TURN, baseStatic, failedTurn, joinSystem, memoryBlock, planBlock, roundCapTurn, summaryBlock, systemParts } from '../system-prompt.ts';

const fact = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, description: `about ${id}`, type: 'note', text: `the ${id}`, mtimeMs: 0, ...over }) as never;

test('the base names the language and the person, and asks for the Next: shape', () => {
  const s = baseStatic({ ai: { assistantLanguage: 'ru' }, user: { name: 'Ann', login: 'ann1' } });
  expect(s).toContain('Always respond in ru');
  expect(s).toContain('You are talking to Ann (login ann1)');
  expect(s).toContain('starts with "Next:"');
  expect(baseStatic({})).not.toContain('You are talking to');
});

test('empty parts are left out and the order is base, screens, memory, project, plan, summary', () => {
  const p = systemParts({}, '## Screens\n- demo — key F2', '## Your memory\nm', [{ id: 't1', text: 'do it', status: 'pending' }], 'older turns');
  const joined = joinSystem(p, '## Project instructions\nx')!;
  const at = (s: string) => joined.indexOf(s);
  expect(at('Always respond')).toBeLessThan(at('## Screens'));
  expect(at('## Screens')).toBeLessThan(at('## Your memory'));
  expect(at('## Your memory')).toBeLessThan(at('## Project instructions'));
  expect(at('## Project instructions')).toBeLessThan(at('## Current task plan'));
  expect(at('## Current task plan')).toBeLessThan(at('Summary of the conversation'));
  const bare = systemParts({}, '', '', [], '');
  expect([bare.screens, bare.memory]).toEqual(['', '']);
  expect(joinSystem(bare, '')).toBe(baseStatic({}));
  expect(joinSystem({ base: '', screens: '', memory: '', plan: '', summary: '' }, '')).toBeNull();
  expect(planBlock([])).toBe('');
  expect(summaryBlock('')).toBe('');
  expect(memoryBlock([], [])).toBe('');
});

test('the memory block lists the index and leaves out a fact changed outside flow-assist', () => {
  const block = memoryBlock([fact('kept')], [fact('edited', { outside: true })]);
  expect(block).toContain('## Your memory');
  expect(block).toContain('kept');
  expect(block).not.toContain('edited');
  expect(memoryBlock([fact('a', { outside: true })], [])).toBe('');
});

test('the closing lines of an unfinished turn', () => {
  expect(STOPPED_TURN).toContain('Stopped by the person');
  expect(roundCapTurn(12, 'read_file')).toContain('after 12 rounds, its limit for one turn (ai.maxRounds); my last step was read_file');
  expect(roundCapTurn(12, undefined, 5000)).toContain('5000 tokens, its budget for one turn (ai.maxTurnTokens)');
  expect(failedTurn('  LLM 500\n boom ')).toBe('(This turn failed before I could finish: LLM 500 boom.)');
  expect(failedTurn('')).toBe('(This turn failed before I could finish.)');
});
