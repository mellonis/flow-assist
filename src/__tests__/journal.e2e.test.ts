// What `/export` makes of the session's journal (src/assistant/journal.ts), through the
// real app: markdown in the shell's directory, every call and the summaries in place, a
// framed result's data and a command's whole output stitched back. What the journal
// holds, and when it is written, is journal.rig.test.ts.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJournal, type JournalEvent } from '../assistant/journal.ts';
import { ScriptedModel, bootApp, handoff, settle } from './helpers/scripted';
import type { Make } from '../loader/plugin.ts';
import { listTree } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-journal-e2e-'));
const rootOf = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-journal-root-')));
const journals = (dir: string) => listTree(dir).filter((n) => n.endsWith('.log.jsonl'));
const journalOf = (dir: string, name = journals(dir)[0]!): JournalEvent[] => readJournal(path.join(dir, name))!;

async function ask(ui: Awaited<ReturnType<typeof bootApp>>, q: string, n = 30) {
  await ui.type(q);
  await ui.press('return');
  await settle(n);
}

test('/export renders the journal to markdown in the shell\'s directory — every call of the session, the summaries in place', async () => {
  const dir = dirOf();
  const root = rootOf();
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'datetime', args: {} }, { tool: 'config_schema', args: {} }], [{ text: 'Первый ответ.' }],
    // Long enough for what it replaces (a config_schema result among it).
    [{ text: handoff(`Итог беседы. ${'подробно '.repeat(200)}`) }],
    [{ tool: 'todo', args: { action: 'add', text: 'проверить' } }], [{ text: 'Второй ответ.' }],
  );
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir }, shell: { roots: [root] } });
  await ui.press('F');
  await ask(ui, 'первый вопрос');
  await ask(ui, '/compact');
  await ask(ui, 'второй вопрос');
  await ask(ui, '/export notes/out.md', 6);
  expect(fs.existsSync(path.join(root, 'notes'))).toBe(false); // a directory that is not there is not made
  expect(ui.backend.lastFrame).toContain('/export');
  await ask(ui, '/export out.md', 6);
  const file = path.join(root, 'out.md');
  const md = fs.readFileSync(file, 'utf8');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(md.match(/<details>/g)).toHaveLength(3);
  for (const name of ['datetime', 'config_schema', 'todo']) expect(md).toContain(`<summary>${name} · `);
  expect(md).toContain('"text": "проверить"');
  expect(md).toContain('первый вопрос');
  expect(md).toContain('Второй ответ.');
  expect(md.indexOf('Итог беседы.')).toBeGreaterThan(md.indexOf('Первый ответ.'));
  expect(md.indexOf('Итог беседы.')).toBeLessThan(md.indexOf('второй вопрос'));
  expect(ui.backend.lastFrame).toContain('Exported');
  // A file that is there already is never overwritten.
  await ask(ui, '/export out.md', 6);
  expect(fs.readFileSync(file, 'utf8')).toBe(md);
  expect(ui.backend.lastFrame).toContain('already exists');
  // With no path: a file named after the session, in the shell's directory.
  await ask(ui, '/export', 6);
  const named = fs.readdirSync(root).filter((n) => /^session-.*\.md$/.test(n));
  expect(named).toHaveLength(1);
  ui.app.unmount();
});

test('/export of a session with no journal renders it from its saved state and says the beginning may be missing', async () => {
  const dir = dirOf();
  const root = rootOf();
  const model = new ScriptedModel();
  model.script([{ text: 'старый ответ' }]);
  const first = await bootApp(model, 100, 28, undefined, { sessions: { dir }, shell: { roots: [root] } });
  await first.press('F');
  await ask(first, 'старый вопрос');
  await first.press('escape', 'escape');
  first.app.unmount();
  for (const n of journals(dir)) fs.unlinkSync(path.join(dir, n)); // as an older host left it

  const ui = await bootApp(new ScriptedModel(), 100, 28, undefined, { sessions: { dir }, shell: { roots: [root] } });
  await settle(6);
  await ui.press('F');
  await ask(ui, '/export old.md', 6);
  const md = fs.readFileSync(path.join(root, 'old.md'), 'utf8');
  expect(md).toContain('beginning may be missing');
  expect(md).toContain('старый вопрос');
  expect(md).toContain('старый ответ');
  ui.app.unmount();

  // A chat where nothing was said has nothing to export.
  const empty = await bootApp(new ScriptedModel(), 100, 28, undefined, { sessions: { dir: dirOf() }, shell: { roots: [root] } });
  await empty.press('F');
  await ask(empty, '/export none.md', 6);
  expect(fs.existsSync(path.join(root, 'none.md'))).toBe(false);
  expect(empty.backend.lastFrame).toContain('nothing to export');
  empty.app.unmount();
});

// A tool that frames its result for the model, as the mcp plugin does: the model reads
// the frame, cut; the data behind it is `raw`.
const BIG = Array.from({ length: 800 }, (_, i) => `row ${i}: ${'data '.repeat(9)}`).join('\n');
const framed = (make: Make) => make('framed', {
  tools: [{
    id: 'framed',
    tools: [
      { type: 'function', function: { name: 'get_big', description: 'Big data, framed.', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'get_none', description: 'A failure answered in words.', parameters: { type: 'object', properties: {} } } },
    ],
    exec: async (name: string) => {
      if (name === 'get_big') return { text: `Result of framed:get — data from a server.\n${BIG.slice(0, 2000)}\n… (clipped)`, raw: BIG };
      if (name === 'get_none') return { text: 'ERROR from framed:get — not found', raw: null };
      throw new Error(`Unknown tool: ${name}`);
    },
  }],
});

test('a framed result: the export keeps the data behind the frame, whole', async () => {
  expect(BIG.length).toBeGreaterThan(40_000);
  const dir = dirOf();
  const root = rootOf();
  const model = new ScriptedModel();
  model.script([{ tool: 'get_big', args: {} }, { tool: 'get_none', args: {} }], [{ text: 'ок' }]);
  const ui = await bootApp(model, 100, 28, (make) => [framed(make)], { sessions: { dir }, shell: { roots: [root] } });
  await ui.press('F');
  await ask(ui, 'дай данные');
  await ask(ui, '/export out.md', 6);
  const md = fs.readFileSync(path.join(root, 'out.md'), 'utf8');
  expect(md).toContain('Data:');
  expect(md).toContain(BIG.split('\n').at(-1)!);
  ui.app.unmount();
});

test('the export stitches a !command\'s whole output back from the journal', async () => {
  const dir = dirOf();
  const root = rootOf();
  const ui = await bootApp(new ScriptedModel(), 100, 28, undefined, { sessions: { dir }, shell: { roots: [root], maxChars: 100 } });
  await ui.press('F');
  await ui.type('!');
  await ui.type('seq 1 3000');
  await ui.press('return');
  await settleUntil(() => journals(dir).length > 0 && journalOf(dir).some((e) => e.t === 'shell-end'), 400);
  const whole = Array.from({ length: 3000 }, (_, i) => `${i + 1}\n`).join('');
  await ask(ui, '/export out.md', 6);
  const md = fs.readFileSync(path.join(root, 'out.md'), 'utf8');
  expect(md).toContain(whole.trimEnd());
  ui.app.unmount();
});

test('the export stitches a model run_command\'s whole output back from the journal', async () => {
  const dir = dirOf();
  const root = rootOf();
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'seq 1 3000' } }], [{ text: 'Готово.' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir }, shell: { roots: [root], maxChars: 100 } });
  await ui.press('F');
  await ui.type('посчитай');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  await ui.press('y');
  await settleUntil(() => journalOf(dir).some((e) => e.t === 'end'), 400);
  const whole = Array.from({ length: 3000 }, (_, i) => `${i + 1}\n`).join('');
  await ask(ui, '/export out.md', 6);
  expect(fs.readFileSync(path.join(root, 'out.md'), 'utf8')).toContain(whole.trimEnd());
  ui.app.unmount();
});

