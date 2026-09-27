import { expect, test } from 'bun:test';
import { keptAfterClear, memoryCommand, memoryNote, type MemoryLists } from '../memory-command';
import { apiHistory } from '../agent';

const fact = (id: string, text: string, type = 'fact') => ({ id, name: id, description: text, type, text, mtimeMs: 1 });
const LISTS: MemoryLists = {
  project: [fact('focus', 'Prompt "focus": generate 7 random numbers and make a plan of them')],
  global: [fact('rebase', 'Prefers rebase over merge', 'preference')],
  projectLabel: '~/p/app',
};
const EMPTY: MemoryLists = { project: [], global: [], projectLabel: '~/p/app' };

test('/memory lists what is remembered per scope, numbered through both, and says it outlives /clear', () => {
  const note = memoryNote(LISTS);
  expect(note).toContain('2 memories');
  expect(note).toContain('kept across /clear and restarts');
  expect(note).toContain('This project (~/p/app):');
  expect(note).toContain('1. Prompt "focus"');
  expect(note).toContain('Every project:');
  expect(note).toContain('2. [preference] Prefers rebase');
  expect(note).toContain('/memory forget');
  expect(memoryCommand('', LISTS).forget).toBeUndefined();
  expect(memoryCommand('list', LISTS).note).toBe(note);
  expect(memoryNote(EMPTY)).toContain('Memory is empty');
  // One scope alone.
  expect(memoryCommand('global', LISTS).note).not.toContain('Prompt "focus"');
  expect(memoryCommand('project', LISTS).note).not.toContain('rebase');
  // No project: the global list alone, said so.
  expect(memoryNote({ ...LISTS, project: [], projectLabel: '' })).toContain('no project');
});

test('/memory forget removes one by its number, a scope, or everything', () => {
  const one = memoryCommand('forget 2', LISTS);
  expect(one.forget).toEqual([{ scope: 'global', id: 'rebase' }]);
  expect(one.note).toContain('Forgot: Prefers rebase');
  expect(memoryCommand('forget project', LISTS).forget).toEqual([{ scope: 'project', id: 'focus' }]);
  expect(memoryCommand('forget global', LISTS).forget).toEqual([{ scope: 'global', id: 'rebase' }]);
  const all = memoryCommand('forget all', LISTS);
  expect(all).toEqual({ note: 'Forgot all 2 memories.', forget: [{ scope: 'project', id: 'focus' }, { scope: 'global', id: 'rebase' }] });
  // A wrong number changes nothing and says what is valid.
  for (const bad of ['forget', 'forget 0', 'forget 3', 'forget x', 'forget 1.5']) {
    const r = memoryCommand(bad, LISTS);
    expect(r.forget).toBeUndefined();
    expect(r.note).toContain('from 1 to 2');
  }
  expect(memoryCommand('forget 1', EMPTY).note).toBe('Memory is already empty.');
  expect(memoryCommand('burn', LISTS).note).toContain('Unknown: /memory burn');
});

test('/clear says what it did not clear', () => {
  expect(keptAfterClear(0)).toBe('');
  expect(keptAfterClear(1)).toContain('1 memory is kept');
  expect(keptAfterClear(2)).toContain('2 memories are kept');
  expect(keptAfterClear(2)).toContain('/memory');
});

test('a note is for the person: it never enters the model\'s history', () => {
  const out = apiHistory([
    { role: 'user', content: 'hi' },
    { role: 'note', content: '2 memories — …' },
    { role: 'assistant', content: 'hello' },
  ] as never);
  expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
});
