// The session's journal (src/assistant/journal.ts), through the real app: written as
// things happen — never at save — and never trimmed.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJournal, type JournalEvent } from '../assistant/journal.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

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
  await ask(ui, 'покажи схему');
  expect(ui.backend.lastFrame).toContain('Схема на месте.');
  // No save has happened yet (the debounce is 250 ms, and nothing closed the chat):
  // this is what a crash would leave.
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
  expect(events.map((e) => e.t)).toEqual(['start', 'row', 'step', 'call', 'answer', 'end']);
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
