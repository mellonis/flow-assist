// The session's journal (src/assistant/journal.ts), through the real app: written as
// things happen — never at save — and never trimmed.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJournal, type JournalEvent } from '../assistant/journal.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import type { Make } from '../loader/plugin.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-journal-e2e-'));
const rootOf = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-journal-root-')));
const journals = (dir: string) => fs.readdirSync(dir).filter((n) => n.endsWith('.log.jsonl'));
const journalOf = (dir: string, name = journals(dir)[0]!): JournalEvent[] => readJournal(path.join(dir, name))!;

async function boot(dir: string, model: ScriptedModel, extra: Record<string, unknown> = {}) {
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir }, shell: { roots: [rootOf()] }, ...extra });
  await ui.press('F');
  return ui;
}
async function ask(ui: Awaited<ReturnType<typeof boot>>, q: string, n = 30) {
  await ui.type(q);
  await ui.press('return');
  await settle(n);
}

test('a crash before any save leaves every row and every call — whole, before the cap — in the journal', async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  model.script(
    [{ text: 'Next: посмотреть схему', tool: 'config_schema', args: {} }],
    [{ text: 'Схема на месте.' }],
  );
  const ui = await boot(dir, model, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', toolResultMaxChars: 200 } });
  await ui.type('покажи схему');
  await ui.press('return');
  // The moment the turn has ended — before the save it schedules (250 ms later, and
  // nothing closed the chat): this is what a crash would leave.
  await settleUntil(() => journals(dir).length > 0 && journalOf(dir).some((e) => e.t === 'end'));
  expect(fs.readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(0);
  const events = journalOf(dir);
  expect(events[0]).toMatchObject({ t: 'start' });
  expect(events.find((e) => e.t === 'row' && e.role === 'user')).toMatchObject({ text: 'покажи схему' });
  expect(events.find((e) => e.t === 'step')).toMatchObject({ text: 'Next: посмотреть схему' });
  const call = events.find((e) => e.t === 'call')!;
  expect(call).toMatchObject({ name: 'config_schema', args: {}, outcome: 'ok' });
  // The model got 200 characters and a cut note; the journal keeps what the tool returned.
  expect(String(call.result).length).toBeGreaterThan(1000);
  expect(String(call.result)).not.toContain('[cut:');
  expect(events.find((e) => e.t === 'answer')).toMatchObject({ text: 'Схема на месте.' });
  expect(events.at(-1)).toMatchObject({ t: 'end' });
  // The order is the order it happened in.
  expect(events.map((e) => e.t)).toEqual(['start', 'row', 'step', 'call-start', 'call', 'answer', 'end']);
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Схема на месте.');
  ui.app.unmount();
});

test('a session longer than the cap: the state file lost its first question, the journal keeps it and every call', async () => {
  const dir = dirOf();
  const many = (n: number) => Array.from({ length: n }, () => ({ tool: 'datetime', args: {} }));
  const model = new ScriptedModel();
  model.script(many(150), [{ text: 'первый готов' }], many(150), [{ text: 'второй готов' }], many(150), [{ text: 'третий готов' }]);
  const ui = await boot(dir, model);
  for (const q of ['раз', 'два', 'три']) {
    await ask(ui, q, 40);
    await ui.press('escape', 'escape'); // a save after every turn
    await ui.press('F');
  }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((n) => n.endsWith('.json'))!), 'utf8'));
  expect(saved.api.some((m: { content: unknown }) => m.content === 'раз')).toBe(false);
  const events = journalOf(dir);
  expect(events.find((e) => e.t === 'row' && e.role === 'user')).toMatchObject({ text: 'раз' });
  expect(events.filter((e) => e.t === 'call')).toHaveLength(450);
  ui.app.unmount();
});

test('a compact writes its summary to the journal, and the journal keeps what was compacted', async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  model.script([{ text: 'Тренд — вверх.' }], [{ text: 'Итог: тренд вверх.' }]);
  const ui = await boot(dir, model);
  await ask(ui, 'как тренд?');
  await ask(ui, '/compact');
  expect(ui.backend.lastFrame).toContain('compacted');
  const events = journalOf(dir);
  const at = events.findIndex((e) => e.t === 'compact');
  expect(events[at]).toMatchObject({ summary: 'Итог: тренд вверх.' });
  expect(events.slice(0, at).some((e) => e.t === 'answer' && e.text === 'Тренд — вверх.')).toBe(true);
  ui.app.unmount();
});

test('a note said before anything else waits for the session; /new starts a journal of its own', async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  model.script([{ text: 'первый ответ' }], [{ text: 'второй ответ' }]);
  const ui = await boot(dir, model);
  await ui.type('/title');
  await ui.press('return');
  await settle(6);
  expect(journals(dir)).toHaveLength(0); // nothing said yet: no session, no journal
  await ask(ui, 'первый вопрос');
  const first = journalOf(dir);
  expect(first.map((e) => e.t)).toEqual(['start', 'row', 'row', 'answer', 'end']);
  expect(first[1]).toMatchObject({ role: 'note' });
  expect(first[2]).toMatchObject({ role: 'user', text: 'первый вопрос' });
  await ask(ui, '/new', 6);
  await ask(ui, 'второй вопрос');
  const names = journals(dir);
  expect(names).toHaveLength(2);
  const second = names.map((n) => journalOf(dir, n)).find((j) => j.some((e) => e.text === 'второй вопрос'))!;
  expect(second.some((e) => e.text === 'первый вопрос')).toBe(false);
  ui.app.unmount();
});

test('a fork starts its own journal with a pointer to the session it came from', async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  model.script([{ text: 'ответ' }], [{ text: 'ответ 2' }]);
  const ui = await boot(dir, model);
  await ask(ui, 'первый вопрос');
  await ui.press('escape', 'escape'); // the first save
  const name = fs.readdirSync(dir).find((n) => n.endsWith('.json'))!;
  const file = path.join(dir, name);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, rev: Number(raw.rev) + 5 })); // a foreign write — the next save forks
  await ui.press('F');
  await ask(ui, 'следующий вопрос');
  await ui.press('escape', 'escape');
  const parent = name.replace(/\.json$/, '');
  const forked = journals(dir).find((n) => !n.startsWith(parent))!;
  expect(forked).toBeDefined();
  const events = journalOf(dir, forked);
  expect(events[0]).toMatchObject({ t: 'start', parent });
  ui.app.unmount();
});

test('a session saved before journals existed starts its journal with what its state file holds', async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  model.script([{ text: 'ответ' }]);
  const first = await boot(dir, model);
  await ask(first, 'старый вопрос');
  await first.press('escape', 'escape');
  first.app.unmount();
  for (const n of journals(dir)) fs.unlinkSync(path.join(dir, n)); // as an older host left it

  const next = new ScriptedModel();
  next.script([{ text: 'новый ответ' }]);
  const ui = await bootApp(next, 100, 28, undefined, { sessions: { dir }, shell: { roots: [rootOf()] } });
  await settle(6);
  await ui.press('F');
  await ask(ui, 'новый вопрос');
  const events = journalOf(dir);
  expect(events[0]).toMatchObject({ t: 'start', continued: true });
  expect(events[1]).toMatchObject({ t: 'row', role: 'user', text: 'старый вопрос', imported: true });
  expect(events.some((e) => e.t === 'row' && e.text === 'новый вопрос' && !e.imported)).toBe(true);
  ui.app.unmount();
});

test('/export renders the journal to markdown in the shell\'s directory — every call of the session, the summaries in place', async () => {
  const dir = dirOf();
  const root = rootOf();
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'datetime', args: {} }, { tool: 'config_schema', args: {} }], [{ text: 'Первый ответ.' }],
    [{ text: 'Итог беседы.' }],
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

test('a !command is in the journal from the moment it starts; its end adds the exit, the time and the output', async () => {
  const dir = dirOf();
  const ui = await boot(dir, new ScriptedModel());
  await ui.type('!');
  await ui.type('sleep 1; echo готово');
  await ui.press('return');
  await settleUntil(() => journals(dir).length > 0);
  // Still running — what a crash now would leave: the command that ran.
  const started = journalOf(dir);
  expect(started.find((e) => e.t === 'shell')).toMatchObject({ command: 'sleep 1; echo готово' });
  expect(started.some((e) => e.t === 'shell-end')).toBe(false);
  await settleUntil(() => journalOf(dir).some((e) => e.t === 'shell-end'), 600);
  const end = journalOf(dir).find((e) => e.t === 'shell-end')!;
  expect(end).toMatchObject({ command: 'sleep 1; echo готово', status: expect.stringContaining('exit 0') });
  expect(String(end.output)).toContain('готово');
  expect(typeof end.ms).toBe('number');
  ui.app.unmount();
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

test('a framed result: the journal and the export keep the data behind the frame, whole', async () => {
  expect(BIG.length).toBeGreaterThan(40_000);
  const dir = dirOf();
  const root = rootOf();
  const model = new ScriptedModel();
  model.script([{ tool: 'get_big', args: {} }, { tool: 'get_none', args: {} }], [{ text: 'ок' }]);
  const ui = await bootApp(model, 100, 28, (make) => [framed(make)], { sessions: { dir }, shell: { roots: [root] } });
  await ui.press('F');
  await ask(ui, 'дай данные');
  const calls = journalOf(dir).filter((e) => e.t === 'call');
  expect(calls[0]).toMatchObject({ name: 'get_big', raw: BIG });
  expect(String(calls[0]!.result)).toContain('(clipped)');
  expect(calls[1]).toMatchObject({ name: 'get_none', raw: null });
  await ask(ui, '/export out.md', 6);
  const md = fs.readFileSync(path.join(root, 'out.md'), 'utf8');
  expect(md).toContain('Data:');
  expect(md).toContain(BIG.split('\n').at(-1)!);
  ui.app.unmount();
});

test('a !command whose output was longer than the host keeps: the journal says how much was cut, and so does the export', async () => {
  const dir = dirOf();
  const root = rootOf();
  const ui = await bootApp(new ScriptedModel(), 100, 28, undefined, { sessions: { dir }, shell: { roots: [root], maxChars: 100 } });
  await ui.press('F');
  await ui.type('!');
  await ui.type('seq 1 300');
  await ui.press('return');
  await settleUntil(() => journals(dir).length > 0 && journalOf(dir).some((e) => e.t === 'shell-end'), 400);
  const end = journalOf(dir).find((e) => e.t === 'shell-end')!;
  const whole = Array.from({ length: 300 }, (_, i) => `${i + 1}\n`).join('');
  expect(Number(end.cut)).toBeGreaterThan(0);
  expect(end.total).toBe(whole.length);
  expect(String(end.output).length + Number(end.cut)).toBe(whole.length);
  await ask(ui, '/export out.md', 6);
  const md = fs.readFileSync(path.join(root, 'out.md'), 'utf8');
  expect(md).toContain(`${end.cut} characters before this were not kept (shell.maxChars)`);
  ui.app.unmount();
});

test('a model tool call is journaled when it starts — waiting on a y/n — and the answer and its end follow', async () => {
  const dir = dirOf();
  const root = rootOf();
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'echo привет' } }], [{ text: 'Готово.' }]);
  const ui = await bootApp(model, 100, 28, undefined, { sessions: { dir }, shell: { roots: [root] } });
  await ui.press('F');
  await ui.type('скажи привет');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  // What a crash now would leave: the call that was about to run, and that it waited.
  const waiting = journalOf(dir);
  expect(waiting.find((e) => e.t === 'call-start')).toMatchObject({ name: 'run_command', args: { command: 'echo привет' }, confirm: true });
  expect(waiting.some((e) => e.t === 'call' || e.t === 'confirm')).toBe(false);
  await ui.press('y');
  await settleUntil(() => journalOf(dir).some((e) => e.t === 'end'));
  const events = journalOf(dir);
  const start = events.find((e) => e.t === 'call-start')!;
  expect(events.find((e) => e.t === 'confirm')).toMatchObject({ id: start.id, name: 'run_command', answer: 'yes', by: 'person' });
  expect(events.find((e) => e.t === 'call')).toMatchObject({ id: start.id, outcome: 'applied' });
  expect(events.map((e) => e.t).filter((t) => t.startsWith('call') || t === 'confirm')).toEqual(['call-start', 'confirm', 'call']);
  ui.app.unmount();
});

test('a fork in the middle of a turn: the rest of the turn lands in the fork\'s journal, not the parent\'s', async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  model.script([{ text: 'первый ответ' }], [{ hold: true }, { text: 'второй ответ' }]);
  const ui = await boot(dir, model);
  await ask(ui, 'первый вопрос');
  await ui.press('escape', 'escape'); // the first save
  await ui.press('F');
  const name = fs.readdirSync(dir).find((n) => n.endsWith('.json'))!;
  const parent = name.replace(/\.json$/, '');
  const file = path.join(dir, name);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, rev: Number(raw.rev) + 5 })); // a foreign write
  await ui.type('второй вопрос');
  await ui.press('return');
  await new Promise((r) => setTimeout(r, 400)); // the question's own save forks, mid-turn
  await settle(4);
  const forkedName = journals(dir).find((n) => !n.startsWith(parent))!;
  expect(forkedName).toBeDefined();
  model.release();
  await settleUntil(() => journalOf(dir, forkedName).some((e) => e.t === 'end'));
  const parentJournal = journalOf(dir, `${parent}.log.jsonl`);
  expect(parentJournal.some((e) => e.text === 'второй ответ')).toBe(false);
  const forked = journalOf(dir, forkedName);
  expect(forked[0]).toMatchObject({ t: 'start', parent });
  expect(forked.some((e) => e.t === 'answer' && e.text === 'второй ответ')).toBe(true);
  ui.app.unmount();
});

test('a background task\'s own calls are journaled in the session that started it, under the task\'s label', async () => {
  const dir = dirOf();
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'background', args: { task: 'узнать время', label: 'часы' } }],
    [{ text: 'Запустил.' }],
    [{ tool: 'datetime', args: {} }],
    [{ text: 'Сейчас полдень.' }],
  );
  const ui = await boot(dir, model);
  await ask(ui, 'узнай время в фоне');
  await settleUntil(() => journalOf(dir).some((e) => e.t === 'call' && e.task === 'часы'), 400);
  const events = journalOf(dir);
  expect(events.find((e) => e.t === 'call-start' && e.task === 'часы')).toMatchObject({ name: 'datetime', args: {} });
  expect(events.find((e) => e.t === 'call' && e.task === 'часы')).toMatchObject({ name: 'datetime', outcome: 'ok' });
  expect(String(events.find((e) => e.t === 'call' && e.task === 'часы')!.result)).toContain('iso-utc');
  ui.app.unmount();
});
