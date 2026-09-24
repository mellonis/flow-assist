// Bulky content — an attached image, a `!command`'s output, a large tool result — is
// sent in full in the turn it arrives in and, once a batch has stubbed it, as a short
// stub the model reads again with `recall`. What the model is SENT is what these tests
// read: the scripted model records every request, turn after turn.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { png } from './helpers/image-fixtures';

const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'sk-ant-scripted'; });
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey;
});

const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type Part = { type: string; text?: string; image_url?: { url: string } };
type Msg = { role: string; content: string | Part[] | null; tool_call_id?: string };
type Req = { messages: Msg[] };
const req = (model: ScriptedModel, i: number) => model.requests[i] as unknown as Req;
const textOf = (c: unknown) => (Array.isArray(c) ? (c as Part[]).filter((p) => p.type === 'text').map((p) => p.text).join('\n') : String(c ?? ''));
const imageUrls = (r: Req) => r.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url!.url) : []));
const b64 = (file: string) => fs.readFileSync(file).toString('base64');
const idOf = (file: string) => `img:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8)}`;
// A request's messages are a prefix of the next one's — nothing before the new turn moved.
const isPrefix = (prev: Req, next: Req) => { expect(next.messages.slice(0, prev.messages.length)).toEqual(prev.messages); };

// A 1000-token window: `usage` says how full it reads after each answer.
const AI = { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', contextWindow: 1000 };
const under = { prompt_tokens: 100, completion_tokens: 10 }; // 11% — no batch
const over = { prompt_tokens: 600, completion_tokens: 10 }; // 61% — past the threshold

function shot() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-recall-')));
  const file = path.join(dir, 'shot.png');
  fs.writeFileSync(file, png(1000, 750));
  return { dir, file };
}

async function boot(model: ScriptedModel, extra: Record<string, unknown> = {}, ai: Record<string, unknown> = {}) {
  const ui = await bootApp(model, 120, 36, undefined, { ai: { ...AI, recall: { everyTurns: 0 }, ...ai }, ...extra });
  await ui.press('F');
  return ui;
}
async function ask(ui: Awaited<ReturnType<typeof boot>>, model: ScriptedModel, text: string, requests: number) {
  await ui.type(text);
  await ui.press('return');
  await settleUntil(() => model.requests.length >= requests);
  await settle(8);
}

test('an attached image goes in full in its turn and until the context passes the threshold; then a stub, and recall sends it again as an image for one turn', async () => {
  const { file } = shot();
  const id = idOf(file);
  const model = new ScriptedModel();
  model.usage = under;
  model.script([{ text: 'A screenshot.' }], [{ text: 'Still here.' }], [{ text: 'Noted.' }]);
  const ui = await boot(model);
  ui.backend.paste(file);
  await settle();
  await ask(ui, model, 'what is this?', 1);
  // Its own turn: the image as a part.
  expect(imageUrls(req(model, 0))).toEqual([`data:image/png;base64,${b64(file)}`]);
  // Under the threshold the next turn still carries it, and the prefix is untouched.
  await ask(ui, model, 'and now?', 2);
  expect(imageUrls(req(model, 1))).toEqual([`data:image/png;base64,${b64(file)}`]);
  isPrefix(req(model, 0), req(model, 1));

  // This answer reads the context past the threshold: the turn's end stubs the image,
  // and the NEXT request carries the stub in the message's text, no image anywhere.
  model.usage = over;
  await ask(ui, model, 'more', 3);
  expect(imageUrls(req(model, 2))).toEqual([`data:image/png;base64,${b64(file)}`]); // the turn that measured it still sent it
  model.script([{ tool: 'recall', args: { id } }], [{ text: 'Seen again.' }], [{ text: 'Fine.' }]);
  await ask(ui, model, 'look again', 5);
  const stubbed = req(model, 3);
  expect(imageUrls(stubbed)).toEqual([]);
  expect(JSON.stringify(stubbed)).not.toContain('base64');
  const first = stubbed.messages.find((m) => m.role === 'user')!;
  expect(first.content).toBe(`[Image #1] what is this?\n[image shot.png · 1000×750 — recall("${id}")]`);
  // The recall: its result names the item, and the image follows as a part of a user
  // message right after the tool results — the OpenAI wire takes no image in a tool
  // message — with the data read again from the file.
  const recalled = req(model, 4);
  const result = recalled.messages.find((m) => m.role === 'tool')!;
  expect(result.content).toBe(`OK: [recalled ${id} — shot.png · 1000×750 — sent as an image beside this result, for this turn]`);
  const after = recalled.messages[recalled.messages.indexOf(result) + 1]!;
  expect(after.role).toBe('user');
  expect(after.content).toEqual([{ type: 'text', text: '[recalled image shot.png — from the app, not a message from the person]' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64(file)}` } }]);
  // The stub in the first message stays a stub — the recall is beside the result.
  expect(recalled.messages.find((m) => m.role === 'user')!.content).toBe(first.content);
  expect(ui.backend.lastFrame).toContain('Seen again.');

  // For that turn only: the next turn's history keeps the result's text and no image.
  await ask(ui, model, 'thanks', 6);
  const later = req(model, 5);
  expect(imageUrls(later)).toEqual([]);
  expect(JSON.stringify(later)).not.toContain('base64');
  expect(later.messages.filter((m) => m.role === 'tool')).toHaveLength(1);
  expect(later.messages.some((m) => textOf(m.content).includes('[recalled image shot.png'))).toBe(false);
  ui.app.unmount();
});

test('the same on the Anthropic wire: the stub replaces the image block, and recall puts the image back as a block after the tool result', async () => {
  const { file } = shot();
  const id = idOf(file);
  const model = new ScriptedModel();
  model.wire = 'anthropic';
  model.anthropicUsage = { input_tokens: 100, output_tokens: 10 };
  model.script([{ text: 'A screenshot.' }], [{ text: 'Noted.' }]);
  const ui = await bootApp(model, 120, 36, undefined, { ai: { provider: 'anthropic', model: 'claude-sonnet-5', toolLoading: 'all', contextWindow: 1000, recall: { everyTurns: 0 } } });
  await ui.press('F');
  ui.backend.paste(file);
  await settle();
  type Block = Record<string, unknown> & { type: string };
  type Sent = { messages: { role: string; content: Block[] }[] };
  const sent = (i: number) => model.requests[i] as unknown as Sent;
  const images = (i: number) => sent(i).messages.flatMap((m) => m.content.filter((b) => b.type === 'image'));
  await ask(ui, model, 'what is this?', 1);
  expect(images(0)).toHaveLength(1);
  model.anthropicUsage = { input_tokens: 600, output_tokens: 10 };
  await ask(ui, model, 'more', 2);
  expect(images(1)).toHaveLength(1);
  model.script([{ tool: 'recall', args: { id } }], [{ text: 'Seen again.' }]);
  await ask(ui, model, 'again', 4);
  expect(images(2)).toHaveLength(0);
  expect(sent(2).messages[0]!.content).toEqual([{ type: 'text', text: `[Image #1] what is this?\n[image shot.png · 1000×750 — recall("${id}")]` }]);
  // One user turn: the tool result first, then the note and the image — the block the
  // API's own rules want last of all takes the cache breakpoint.
  const last = sent(3).messages.at(-1)!;
  expect(last.role).toBe('user');
  expect(last.content.map((b) => b.type)).toEqual(['tool_result', 'text', 'image']);
  expect(last.content[0]).toMatchObject({ type: 'tool_result', content: `OK: [recalled ${id} — shot.png · 1000×750 — sent as an image beside this result, for this turn]` });
  expect(last.content[2]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(file) }, cache_control: { type: 'ephemeral' } });
  expect(ui.backend.lastFrame).toContain('Seen again.');
  ui.app.unmount();
});

test('a !command output and a large run_command result are stubbed the same way, and come back whole under a header', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-recall-sh-')));
  const model = new ScriptedModel();
  model.usage = under;
  const ui = await boot(model, { shell: { roots: [root] } }, { recall: { everyTurns: 0, minChars: 300 } });
  await ui.type('!seq 1 30');
  await ui.press('return');
  await settleUntil(() => /seq 1 30 · ✓/.test(ui.backend.lastFrame));
  // The command's output rides the next turn in full — and the model's own command,
  // confirmed, leaves a result over minChars.
  model.script([{ tool: 'run_command', args: { command: 'seq 1 200' } }], [{ text: 'Counted.' }], [{ text: 'Yes.' }]);
  await ui.type('count on');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Confirm write: run_command'));
  model.usage = over; // the round after the command reads past the threshold
  await ui.press('y');
  await settleUntil(() => model.requests.length >= 2);
  await settle(8);
  const full = req(model, 1);
  const shell = full.messages.find((m) => m.role === 'user' && textOf(m.content).startsWith('The person ran a shell command'))!;
  expect(textOf(shell.content).split('\n')).toContain('30');
  const result = full.messages.find((m) => m.role === 'tool')!;
  expect(textOf(result.content).split('\n')).toContain('200');

  // The turn's end batched both: the next request carries two stubs and none of the lines.
  await ask(ui, model, 'what did they print?', 3);
  const stubbed = req(model, 2);
  const shellStub = textOf(stubbed.messages[stubbed.messages.indexOf(stubbed.messages.find((m) => m.role === 'user' && /^\[\$ seq 1 30/.test(textOf(m.content)))!)]!.content);
  expect(shellStub).toMatch(/^\[\$ seq 1 30 — exit 0 · \d+\.\d s · 30 lines — recall\("out:[0-9a-f]{8}"\)\]$/);
  const resultStub = textOf(stubbed.messages.find((m) => m.role === 'tool')!.content);
  expect(resultStub).toMatch(/^\[run_command seq 1 200 — \d+ lines — recall\("res:[0-9a-f]{8}"\)\]$/);
  expect(JSON.stringify(stubbed.messages).split('\n').length).toBeLessThan(20);
  const outId = /recall\("(out:[0-9a-f]{8})"\)/.exec(shellStub)![1]!;
  const resId = /recall\("(res:[0-9a-f]{8})"\)/.exec(resultStub)![1]!;

  // Both recalled in one round, by a prefix: whole, each under its header. An id
  // nothing matches is answered, not thrown.
  model.script([{ tool: 'recall', args: { id: outId.slice(0, 7) } }, { tool: 'recall', args: { id: resId } }, { tool: 'recall', args: { id: 'img:0000' } }], [{ text: 'Both back.' }]);
  await ask(ui, model, 'show me', 5);
  // The last three tool messages: the first is the earlier command's result, stubbed.
  const back = req(model, 4).messages.filter((m) => m.role === 'tool').slice(-3).map((m) => textOf(m.content));
  expect(back[0]).toMatch(new RegExp(`^OK: \\[recalled ${outId} — \\d+ lines\\]\\nThe person ran a shell command`));
  expect(back[0]!.split('\n')).toContain('30');
  // A result comes back as the history holds it — its own `OK:` tag included.
  expect(back[1]).toMatch(new RegExp(`^OK: \\[recalled ${resId} — \\d+ lines\\]\\nOK: Ran in `));
  expect(back[1]!.split('\n')).toContain('200');
  expect(back[2]).toContain('OK: recall: nothing in the conversation matches "img:0000"');
  // The stubs in the history stay stubs: the item is beside the recall, not put back in place.
  expect(textOf(req(model, 4).messages.find((m) => m.role === 'tool')!.content)).toBe(resultStub);
  expect(ui.backend.lastFrame).toContain('Both back.');
  ui.app.unmount();
});

test('stubbing is one batch: the prefix is byte-stable between turns with no batch, and moves once when one fires', async () => {
  const { file } = shot();
  const model = new ScriptedModel();
  model.usage = under;
  model.script([{ text: 'one' }], [{ text: 'two' }], [{ text: 'three' }], [{ text: 'four' }], [{ text: 'five' }]);
  const ui = await boot(model);
  ui.backend.paste(file);
  await settle();
  await ask(ui, model, 'first', 1);
  ui.backend.paste(file); // the same image again: one id, one item
  await settle();
  await ask(ui, model, 'second', 2);
  await ask(ui, model, 'third', 3);
  isPrefix(req(model, 0), req(model, 1));
  isPrefix(req(model, 1), req(model, 2));
  expect(imageUrls(req(model, 2))).toHaveLength(2);
  model.usage = over;
  await ask(ui, model, 'fourth', 4);
  isPrefix(req(model, 2), req(model, 3)); // the turn that reads over the threshold still went unchanged
  await ask(ui, model, 'fifth', 5);
  // One batch: both messages lost their image at once, everything else stands.
  const moved = req(model, 4);
  expect(imageUrls(moved)).toHaveLength(0);
  const users = moved.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
  expect(users[0]).toMatch(/^\[Image #1\] first\n\[image shot\.png · 1000×750 — recall\("img:[0-9a-f]{8}"\)\]$/);
  expect(users[1]).toMatch(/^\[Image #2\] second\n\[image shot\.png · 1000×750 — recall\("img:[0-9a-f]{8}"\)\]$/);
  expect(moved.messages.filter((m) => m.role === 'assistant')).toEqual(req(model, 3).messages.filter((m) => m.role === 'assistant').concat([{ role: 'assistant', content: 'four' }]));
  ui.app.unmount();
});

test('every N turns: under the threshold a batch still fires on the turn clock', async () => {
  const { file } = shot();
  const model = new ScriptedModel();
  model.usage = under;
  model.script([{ text: 'one' }], [{ text: 'two' }], [{ text: 'three' }]);
  const ui = await boot(model, {}, { recall: { everyTurns: 2 } });
  ui.backend.paste(file);
  await settle();
  await ask(ui, model, 'first', 1);
  await ask(ui, model, 'second', 2);
  expect(imageUrls(req(model, 1))).toHaveLength(1); // the second turn: the clock is at 1
  await ask(ui, model, 'third', 3);
  expect(imageUrls(req(model, 2))).toHaveLength(0); // the second turn's end was the 2nd: batched
  ui.app.unmount();
});

test('ai.recall.enabled false: everything goes in full whatever the context reads, and the recall tool is not offered', async () => {
  const { file } = shot();
  const model = new ScriptedModel();
  model.usage = over;
  model.script([{ text: 'one' }], [{ text: 'two' }], [{ text: 'three' }]);
  const ui = await boot(model, {}, { recall: { enabled: false } });
  ui.backend.paste(file);
  await settle();
  await ask(ui, model, 'first', 1);
  await ask(ui, model, 'second', 2);
  await ask(ui, model, 'third', 3);
  for (const i of [0, 1, 2]) expect(imageUrls(req(model, i))).toEqual([`data:image/png;base64,${b64(file)}`]);
  expect(JSON.stringify(model.requests)).not.toContain('recall("');
  // Nothing is ever stubbed, so a tool that reads stubs again has nothing to do — it
  // is not in the list at all (on by default, it is).
  const names = (i: number) => ((model.requests[i] as unknown as { tools?: { function: { name: string } }[] }).tools ?? []).map((t) => t.function.name);
  expect(names(0)).not.toContain('recall');
  ui.app.unmount();
  const on = new ScriptedModel();
  on.script([{ text: 'hi' }]);
  const ui2 = await boot(on);
  await ask(ui2, on, 'hi', 1);
  expect(names.call(null, 0)).not.toContain('recall'); // the first model's list, unchanged
  expect(((on.requests[0] as unknown as { tools: { function: { name: string } }[] }).tools).map((t) => t.function.name)).toContain('recall');
  ui2.app.unmount();
});

test('the session keeps the content and the stubbed set: after a restart the stub still goes, and recall reads the image from its path', async () => {
  const { file } = shot();
  const id = idOf(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-recall-sess-'));
  const first = new ScriptedModel();
  first.usage = over;
  first.script([{ text: 'one' }]);
  const a = await boot(first, { sessions: { dir } });
  a.backend.paste(file);
  await settle();
  await ask(a, first, 'first', 1);
  await a.press('escape', 'escape'); // closing the chat saves at once
  a.app.unmount();
  const [name] = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, name!), 'utf8'));
  expect(saved.recall).toEqual({ stubbed: [id], turns: 0 });
  // The full content is what is kept: the ref on the message, never a stub in its place.
  expect(JSON.stringify(saved.api)).toContain('"sha256"');
  expect(JSON.stringify(saved.api)).not.toContain('recall("');

  const second = new ScriptedModel();
  second.usage = under;
  second.script([{ tool: 'recall', args: { id } }], [{ text: 'Back.' }]);
  const b = await boot(second, { sessions: { dir } });
  await ask(b, second, 'again', 2);
  expect(imageUrls(req(second, 0))).toEqual([]);
  expect(textOf(req(second, 0).messages.find((m) => m.role === 'user')!.content)).toBe(`[Image #1] first\n[image shot.png · 1000×750 — recall("${id}")]`);
  expect(imageUrls(req(second, 1))).toEqual([`data:image/png;base64,${b64(file)}`]);
  expect(b.backend.lastFrame).toContain('Back.');
  b.app.unmount();
});

test('/context says how many items are stubbed and how many were recalled this turn', async () => {
  const { file } = shot();
  const model = new ScriptedModel();
  model.usage = over;
  model.script([{ text: 'one' }], [{ tool: 'recall', args: { id: idOf(file) } }], [{ text: 'two' }]);
  const ui = await boot(model);
  await ui.type('/context');
  await ui.press('return');
  expect(ui.backend.lastFrame).not.toContain('recall:'); // nothing to say yet
  await ui.press('escape');
  ui.backend.paste(file);
  await settle();
  await ask(ui, model, 'first', 1);
  await ui.type('/context');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('recall: 1 item stubbed · none recalled this turn');
  await ui.press('escape');
  await ask(ui, model, 'again', 3);
  await ui.type('/context');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('recall: 1 item stubbed · 1 recalled this turn');
  ui.app.unmount();
});
