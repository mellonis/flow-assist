// /compact writes a HANDOFF for the model that continues (src/assistant/compaction.ts):
// fixed sections, the previous summary carried forward and REPLACED, one retry for an
// answer that is not a handoff, and no tool-call markup stored.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SESSION_VERSION, newSessionId, saveSession } from '../assistant/sessions.ts';
import { ScriptedModel, bootApp, handoff, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type UI = Awaited<ReturnType<typeof bootApp>>;
type Req = { messages: { role: string; content: unknown }[] };
const req = (model: ScriptedModel, i: number) => model.requests[i] as unknown as Req;
const system = (model: ScriptedModel, i: number) => String(req(model, i).messages.find((m) => m.role === 'system')?.content ?? '');
const userText = (model: ScriptedModel, i: number) => req(model, i).messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');

async function ask(ui: UI, text: string) {
  await ui.type(text);
  await ui.press('return');
  await settle(20);
}
async function compact(ui: UI) {
  await ui.type('/compact');
  await ui.press('return');
  await settle(20);
}

test('the compaction asks for the handoff sections, carries the previous summary, and the new one replaces it', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: 'The first answer.' }], [{ text: handoff('FIRST-HANDOFF') }],
    [{ text: 'The second answer.' }], [{ text: handoff('SECOND-HANDOFF') }],
    [{ text: 'The third answer.' }],
  );
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  await ask(ui, 'the first question');
  await compact(ui);
  // The instruction is the handoff's, with every section; the conversation is one
  // user message of text, and there is no previous handoff yet.
  const first = system(model, 1);
  for (const s of ['## Goal', '## Done', '## In progress', '## Open decisions', '## Facts learned']) expect(first).toContain(s);
  expect(first).toMatch(/no question to the person/);
  expect(req(model, 1).messages.map((m) => m.role)).toEqual(['system', 'user']);
  expect(userText(model, 1)).toContain('user: the first question');
  expect(userText(model, 1)).not.toContain('previous handoff');

  await ask(ui, 'the second question');
  expect(system(model, 2)).toContain('FIRST-HANDOFF');
  await compact(ui);
  // The second compaction is shown the first summary, to carry forward.
  expect(userText(model, 3)).toContain('The previous handoff');
  expect(userText(model, 3)).toContain('FIRST-HANDOFF');

  await ask(ui, 'the third question');
  // Replaced, never appended: the model now sees the second summary alone.
  expect(system(model, 4)).toContain('SECOND-HANDOFF');
  expect(system(model, 4)).not.toContain('FIRST-HANDOFF');
  expect(ui.backend.lastFrame).toContain('The third answer.');
});

test('the whole history is compacted, not its last messages', async () => {
  const model = new ScriptedModel();
  const turns = Array.from({ length: 18 }, (_, i) => [{ text: `answer ${i}` }]);
  model.script(...turns, [{ text: handoff('ALL') }]);
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  for (let i = 0; i < 18; i++) await ask(ui, `question ${i}`);
  await compact(ui);
  expect(userText(model, 18)).toContain('user: question 0\n');
});

test('an answer that is not a handoff is asked for once more, with the reason', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: 'The first answer.' }],
    [{ text: 'Отлично! Какой следующий шаг предпочитаете?' }],
    [{ text: handoff('RETRIED') }],
    [{ text: 'The second answer.' }],
  );
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  await ask(ui, 'the first question');
  await compact(ui);
  expect(userText(model, 2)).toMatch(/not a usable handoff: it is missing the sections Goal, Done, In progress, Open decisions, Facts learned/);
  await ask(ui, 'the second question');
  expect(model.requests).toHaveLength(4); // one retry, not more
  expect(system(model, 3)).toContain('RETRIED');
  expect(system(model, 3)).not.toContain('Какой следующий');
  expect(ui.backend.lastFrame).not.toContain('incomplete');
});

test('when the retry fails too, the previous summary stays with the new text, and the row says so', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: 'The first answer.' }], [{ text: handoff('KEPT') }],
    [{ text: 'The second answer.' }], [{ text: 'a chat reply' }], [{ text: 'another chat reply' }],
    [{ text: 'The third answer.' }],
  );
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  await ask(ui, 'the first question');
  await compact(ui);
  await ask(ui, 'the second question');
  await compact(ui);
  const rows = ui.backend.lastFrame.split('\n').filter((r) => r.includes('── compacted'));
  expect(rows).toHaveLength(2);
  expect(rows[1]).toContain('· incomplete, previous kept ──');
  await ask(ui, 'the third question');
  expect(system(model, 5)).toContain('KEPT');
  expect(system(model, 5)).toContain('another chat reply');
});

test('tool-call markup is stripped from the summary before it is stored', async () => {
  const model = new ScriptedModel();
  const marked = `${handoff('MARKED')}\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="read_file">\n<｜DSML｜parameter name="path" string="true">a.ts</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>`;
  model.script([{ text: 'The first answer.' }], [{ text: marked }], [{ text: 'The second answer.' }]);
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  await ask(ui, 'the first question');
  await compact(ui);
  await ask(ui, 'the second question');
  expect(system(model, 2)).toContain('MARKED');
  expect(system(model, 2)).not.toContain('DSML');
  expect(system(model, 2)).not.toContain('invoke');
});

test('a saved summary with tool-call markup in it is read without the markup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sess-handoff-'));
  const now = new Date().toISOString();
  saveSession(dir, {
    version: SESSION_VERSION, id: newSessionId(), title: 'q', createdAt: now, updatedAt: now,
    messages: [], api: [],
    summary: 'OLD-SUMMARY\n<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>',
    plan: [], usage: null, prompts: [], draft: '',
  });
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await bootApp(model, 110, 30, undefined, { sessions: { dir } });
  await settle(6);
  await ui.press('F');
  await ask(ui, 'next');
  expect(system(model, 0)).toContain('OLD-SUMMARY');
  expect(system(model, 0)).not.toContain('tool_call');
});

test('a handoff that names the tags as code is stored whole', async () => {
  const model = new ScriptedModel();
  const about = `${handoff('CODE-TAGS')}\n- the detector skips \`<tool_call>\` and \`<function_calls>\` shown as code\n- LAST-FACT`;
  model.script([{ text: 'The first answer.' }], [{ text: about }], [{ text: 'The second answer.' }]);
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  await ask(ui, 'the first question');
  await compact(ui);
  await ask(ui, 'the second question');
  expect(model.requests).toHaveLength(3); // no retry
  expect(system(model, 2)).toContain('`<tool_call>`');
  expect(system(model, 2)).toContain('LAST-FACT');
});
