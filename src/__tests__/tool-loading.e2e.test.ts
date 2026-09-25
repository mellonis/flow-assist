// Tools on demand, through the real chat: what the model is SENT, round by round.
// A request carries the core tools and an index of the rest; a tool the model has not
// loaded is refused by name; `tools_load` puts its full definition into the very next
// round, and the loaded set is the conversation's — a restart keeps it, /clear empties it.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import type { Make } from '../loader/plugin';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 100) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

type Sent = { messages: { role: string; content?: string | null }[]; tools?: { function: { name: string; description: string } }[] };
const sent = (model: ScriptedModel, i: number) => model.requests[i] as unknown as Sent;
const toolNames = (r: Sent) => (r.tools ?? []).map((t) => t.function.name);

// A guest with a tool group of its own; the notebook is what `notes_read` answers.
const notesPlugin = (make: Make) => make('notes', {
  tools: [{
    id: 'notes',
    tools: [
      { type: 'function', function: { name: 'notes_read', description: 'Read the notebook. Returns every note.', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'notes_count', description: 'Count the notes.', parameters: { type: 'object', properties: {} } } },
    ],
    exec: async (name: string) => (name === 'notes_read' ? 'water the plants' : '1'),
  }],
} as never);

// No `toolLoading` in `ai`: the default, on demand.
const boot = (model: ScriptedModel, sessions: { dir: string }) =>
  bootApp(model, 100, 28, (make) => [notesPlugin(make)], { ai: { baseUrl: 'http://scripted.model', model: 'scripted' }, sessions });

async function ask(ui: Awaited<ReturnType<typeof boot>>, model: ScriptedModel, text: string, requests: number) {
  await ui.type(text);
  await ui.press('return');
  await settleUntil(() => model.requests.length >= requests);
  await settle(5);
}

test('the model sees an index, is refused a tool it did not load, loads it, and gets it in the next round', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'notes_read', args: {} }],
    [{ tool: 'tools_load', args: { names: ['notes_read'] } }],
    [{ tool: 'notes_read', args: {} }],
    [{ text: 'Water the plants.' }],
  );
  const ui = await boot(model, { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fa-load-')) });
  await ui.press('F');
  await ask(ui, model, 'what is in my notes?', 4);

  // Round 1: core in full, the notes only as lines of the index.
  const first = sent(model, 0);
  expect(toolNames(first)).toContain('todo');
  expect(toolNames(first)).toContain('tools_load');
  expect(toolNames(first)).not.toContain('notes_read');
  const index = first.tools!.find((t) => t.function.name === 'tools_load')!.function.description;
  expect(index).toContain('notes:\n- notes_read — Read the notebook.\n- notes_count — Count the notes.');
  // Round 2: the call it made without loading was answered with what to do.
  expect(JSON.stringify(sent(model, 1).messages)).toContain('ERROR: notes_read is not loaded — call tools_load with {\\"names\\": [\\"notes_read\\"]} first');
  expect(toolNames(sent(model, 1))).not.toContain('notes_read');
  // Round 3: loaded — the full definition is sent, and only the one asked for.
  expect(toolNames(sent(model, 2))).toContain('notes_read');
  expect(toolNames(sent(model, 2))).not.toContain('notes_count');
  // Round 4: the call went through.
  expect(JSON.stringify(sent(model, 3).messages)).toContain('OK: water the plants');
  expect(ui.backend.lastFrame).toContain('Water the plants.');
  ui.app.unmount();
});

test('the loaded set survives a restart and is emptied by /clear', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-load-sess-'));
  const first = new ScriptedModel();
  first.script(
    [{ tool: 'tools_load', args: { group: 'notes' } }],
    [{ text: 'Loaded.' }],
  );
  const one = await boot(first, { dir });
  await one.press('F');
  await ask(one, first, 'get the notes tools', 2);
  expect(toolNames(sent(first, 1))).toEqual(expect.arrayContaining(['notes_read', 'notes_count']));
  await one.press('escape', 'escape'); // closing the chat saves at once
  one.app.unmount();

  const model = new ScriptedModel();
  model.script([{ text: 'Still here.' }], [{ text: 'Fresh.' }]);
  const two = await boot(model, { dir });
  await two.press('F');
  await ask(two, model, 'and now?', 1);
  expect(toolNames(sent(model, 0))).toEqual(expect.arrayContaining(['notes_read', 'notes_count']));

  await two.type('/clear');
  await two.press('return');
  await settle(5);
  await ask(two, model, 'hello', 2);
  expect(toolNames(sent(model, 1))).not.toContain('notes_read');
  expect(toolNames(sent(model, 1))).toContain('tools_load');
  two.app.unmount();
});

test('ai.toolLoading all sends every tool in full and offers no tools_load', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Hi.' }]);
  const ui = await bootApp(model, 100, 28, (make) => [notesPlugin(make)], { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all' } });
  await ui.press('F');
  await ask(ui, model, 'hi', 1);
  expect(toolNames(sent(model, 0))).toEqual(expect.arrayContaining(['todo', 'notes_read', 'notes_count']));
  expect(toolNames(sent(model, 0))).not.toContain('tools_load');
  ui.app.unmount();
});

// A guest whose group is over BIG_GROUP_TOOLS (src/assistant/tool-loading.ts) — big
// enough that loading it whole would carry its cost into every later round.
const bigPlugin = (make: Make) => make('acme', {
  tools: [{
    id: 'acme',
    tools: Array.from({ length: 13 }, (_, i) => ({
      type: 'function' as const,
      function: { name: `acme_${i}`, description: `Does thing ${i}. More words here.`, parameters: { type: 'object', properties: {} } },
    })),
    exec: async () => 'ok',
  }],
} as never);

test('a group over BIG_GROUP_TOOLS is not loaded whole; the model reads its index and loads by name instead', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'tools_load', args: { group: 'acme' } }],
    [{ tool: 'tools_load', args: { names: ['acme_0', 'acme_1'] } }],
    [{ text: 'Loaded two.' }],
  );
  const ui = await bootApp(model, 100, 28, (make) => [bigPlugin(make)], { ai: { baseUrl: 'http://scripted.model', model: 'scripted' }, sessions: { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fa-load-big-')) } });
  await ui.press('F');
  await ask(ui, model, 'load the acme tools', 3);

  // Round 1: the whole-group ask is refused with the group's own index and why —
  // never with the 13 full tool definitions.
  const refusal = String(sent(model, 1).messages.find((m) => m.role === 'tool')!.content);
  expect(refusal).toContain('"acme" has 13 tools');
  expect(refusal).toContain('tokens in every later request');
  expect(refusal).toContain('acme_0');
  expect(toolNames(sent(model, 1))).not.toContain('acme_0');
  // Round 3: the two named tools, and only those, are loaded.
  expect(toolNames(sent(model, 2))).toEqual(expect.arrayContaining(['acme_0', 'acme_1']));
  expect(toolNames(sent(model, 2))).not.toContain('acme_2');
  expect(ui.backend.lastFrame).toContain('Loaded two.');
  ui.app.unmount();
});

test("a tool of a big group, called unloaded: the hint's list sent back as a string loads it on that call", async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'tools_load', args: { group: 'acme' } }],
    [{ tool: 'acme_3', args: {} }],
    // The hint's own list, copied into the call as a STRING.
    [{ tool: 'tools_load', args: { names: '["acme_3"]' } }],
    [{ tool: 'acme_3', args: {} }],
    [{ text: 'Did thing 3.' }],
  );
  const ui = await bootApp(model, 100, 28, (make) => [bigPlugin(make)], { ai: { baseUrl: 'http://scripted.model', model: 'scripted' }, sessions: { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fa-load-str-')) } });
  await ui.press('F');
  await ask(ui, model, 'do thing 3', 5);

  const toolReplies = (i: number) => sent(model, i).messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  // The whole group is refused with its index, and the way to name tools is shown as JSON.
  expect(toolReplies(1).at(-1)).toContain('"acme" has 13 tools — load the ones you need with {"names": [...]}');
  // The unloaded call is answered with the call to make, as JSON.
  expect(toolReplies(2).at(-1)).toContain('acme_3 is not loaded — call tools_load with {"names": ["acme_3"]} first');
  // The list sent as a string loads the tool on that call, and only that tool.
  expect(toolReplies(3).at(-1)).toBe('OK: Loaded: acme_3 — call them now.');
  expect(toolNames(sent(model, 3))).toContain('acme_3');
  expect(toolNames(sent(model, 3))).not.toContain('acme_4');
  // The call goes through.
  expect(toolReplies(4).at(-1)).toBe('OK: ok');
  expect(ui.backend.lastFrame).toContain('Did thing 3.');
  ui.app.unmount();
});
