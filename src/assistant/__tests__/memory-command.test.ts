import { expect, test } from 'bun:test';
import { keptAfterClear, memoryCommand, memoryNote } from '../memory-command';
import { apiHistory } from '../agent';

const mem = (id: string, text: string, scope = 'host') => ({ id, text, scope, ts: 1 });
const LIST = [mem('a', 'Prompt "focus": generate 7 random numbers and make a plan of them'), mem('b', 'Prefers rebase over merge', 'acme-tracker')];

test('/memory lists what is remembered and says it outlives /clear', () => {
  const note = memoryNote(LIST);
  expect(note).toContain('2 memories');
  expect(note).toContain('kept across /clear and restarts');
  expect(note).toContain('1. Prompt "focus"');
  expect(note).toContain('2. [acme-tracker] Prefers rebase');
  expect(note).toContain('/memory forget');
  expect(memoryCommand('', LIST).next).toBeUndefined();
  expect(memoryCommand('list', LIST).note).toBe(note);
  expect(memoryNote([])).toContain('Memory is empty');
});

test('/memory forget removes one by its number, or everything', () => {
  const one = memoryCommand('forget 1', LIST);
  expect(one.next).toEqual([LIST[1]!]);
  expect(one.note).toContain('Forgot: Prompt "focus"');
  expect(memoryCommand('forget all', LIST)).toEqual({ note: 'Forgot all 2 memories.', next: [] });
  // A wrong number changes nothing and says what is valid.
  for (const bad of ['forget', 'forget 0', 'forget 3', 'forget x', 'forget 1.5']) {
    const r = memoryCommand(bad, LIST);
    expect(r.next).toBeUndefined();
    expect(r.note).toContain('from 1 to 2');
  }
  expect(memoryCommand('forget 1', []).note).toBe('Memory is already empty.');
  expect(memoryCommand('burn', LIST).note).toContain('Unknown: /memory burn');
});

test('/clear says what it did not clear', () => {
  expect(keptAfterClear([])).toBe('');
  expect(keptAfterClear([LIST[0]!])).toContain('1 memory is kept');
  expect(keptAfterClear(LIST)).toContain('2 memories are kept');
  expect(keptAfterClear(LIST)).toContain('/memory');
});

test('a note is for the person: it never enters the model\'s history', () => {
  const out = apiHistory([
    { role: 'user', content: 'hi' },
    { role: 'note', content: '2 memories — …' },
    { role: 'assistant', content: 'hello' },
  ] as never);
  expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
});
