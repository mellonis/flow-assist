// Where the memory file is, and what the host refuses to put in it.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from '../../../config/load';
import {
  MEMORY_MAX_ENTRIES,
  MEMORY_TEXT_MAX,
  memoryFilePath,
  normalizeMemoryText,
  refuseMemory,
  type Memory,
} from '../memory';

const env = (NODE_ENV: string) => ({ NODE_ENV, XDG_CONFIG_HOME: '/x/cfg' });
const mem = (id: string, text: string, ts = 1): Memory => ({ id, text, scope: 'host', ts });

test('the default memory file is the config directory’s — except under bun test', () => {
  // Outside a test run it is the person's own file, beside the config.
  expect(memoryFilePath({}, env('production'))).toBe(path.join(configDir(env('production')), 'memory.json'));
  // Under `bun test` with no file named it is NOT: a test that reaches the `memory`
  // tool must not append to the person's own memory, as it did 32 times over.
  const underTest = memoryFilePath({}, env('test'));
  expect(underTest).not.toBe(path.join(configDir(env('test')), 'memory.json'));
  expect(underTest.startsWith('/x/cfg')).toBe(false);
  expect(underTest.endsWith('memory.json')).toBe(true);
  // A named file is still honoured, in a test as anywhere else.
  expect(memoryFilePath({ memory: { file: '/tmp/named.json' } }, env('test'))).toBe('/tmp/named.json');
});

test('the same fact in other spacing and case is one fact', () => {
  expect(normalizeMemoryText('This repo prefers rebase over merge.')).toBe('this repo prefers rebase over merge');
  expect(normalizeMemoryText('  this   repo prefers\nrebase over merge  ')).toBe('this repo prefers rebase over merge');
});

test('a duplicate is refused, naming the entry that already says it', () => {
  const list = [mem('m-1', 'This repo prefers rebase over merge.')];
  const refusal = refuseMemory(list, 'this repo prefers  rebase over merge');
  expect(refusal).toContain('m-1');
  expect(refusal).toContain('update');
  expect(refusal).toContain('/memory');
  // A different fact goes in.
  expect(refuseMemory(list, 'The default branch here is master')).toBeNull();
});

test('an entry longer than the cap is refused, with its length', () => {
  const long = 'x'.repeat(MEMORY_TEXT_MAX + 7);
  const refusal = refuseMemory([], long);
  expect(refusal).toContain(String(MEMORY_TEXT_MAX + 7));
  expect(refusal).toContain(String(MEMORY_TEXT_MAX));
  // One character under the cap is stored.
  expect(refuseMemory([], 'x'.repeat(MEMORY_TEXT_MAX))).toBeNull();
});

test('a full memory is refused, and the oldest entries are named', () => {
  const full = Array.from({ length: MEMORY_MAX_ENTRIES }, (_, i) => mem(`m-${i}`, `fact ${i}`, 1000 + i));
  const refusal = refuseMemory(full, 'one more fact');
  expect(refusal).toContain(String(MEMORY_MAX_ENTRIES));
  expect(refusal).toContain('m-0');
  expect(refusal).toContain('fact 0');
  expect(refusal).toContain('/memory forget');
  // The newest entry is not what it points at.
  expect(refusal).not.toContain(`m-${MEMORY_MAX_ENTRIES - 1}`);
  // One short of the cap still takes a new fact.
  expect(refuseMemory(full.slice(1), 'one more fact')).toBeNull();
});

test('services.memory is the global workspace\'s facts, as the list a plugin knows: load maps them, save adds, edits and removes under the tool\'s guards', async () => {
  const { createServices } = await import('../../services.js');
  const { addFact, readFacts } = await import('../../../assistant/memory-store.js');
  const { workspaceDir } = await import('../../../assistant/workspace.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-svc-mem-')));
  const g = workspaceDir(root, null);
  addFact(g, { text: 'Prefers rebase.', type: 'preference' });
  addFact(g, { text: 'Keycaps stay off.', plugin: 'keycaps' });
  const memory = createServices({ config: { workspace: { dir: root } } } as never).memory;
  expect(memory.filePath()).toBe(path.join(g, 'memory'));
  const list = memory.load();
  expect(list.map((m) => [m.text, m.scope, m.label])).toEqual([['Keycaps stay off.', 'keycaps', 'fact'], ['Prefers rebase.', 'global', 'preference']]);
  const [keycaps, rebase] = list;
  memory.save([
    { ...rebase!, text: 'Prefers rebase, always.' },
    { id: 'new', text: 'Answers briefly.', scope: 'global', ts: 1 },
    { id: 'dup', text: 'answers briefly', scope: 'global', ts: 2 },
    { id: 'long', text: 'y'.repeat(400), scope: 'global', ts: 3 },
  ]);
  const after = readFacts(g);
  expect(after.map((f) => f.text).sort()).toEqual(['Answers briefly.', 'Prefers rebase, always.']);
  expect(after.some((f) => f.id === keycaps!.id)).toBe(false);
});
