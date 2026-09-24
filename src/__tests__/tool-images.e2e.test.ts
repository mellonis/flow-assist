// A tool returns images beside its text — screenshots it fetched itself — and the
// model is shown them: inside the `tool_result` on the Anthropic wire, in a user
// message after the results on the OpenAI wire. What the model is SENT is what these
// tests read; the chat shows a mark per image, never the image, and the session keeps
// a ref into the host's own store, never the bytes.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostStateDir } from '../config/load';
import type { Make } from '../loader/plugin';
import { sha256 } from '../assistant/images';
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
const isPrefix = (prev: Req, next: Req) => { expect(next.messages.slice(0, prev.messages.length)).toEqual(prev.messages); };

const A = png(400, 300, 1);
const B = png(640, 480, 2);
const url = (b: Uint8Array) => `data:image/png;base64,${Buffer.from(b).toString('base64')}`;
const idOf = (b: Uint8Array) => `img:${sha256(b).slice(0, 8)}`;

// A tool group of a plugin: `get_shots` declares that it returns images, `sneaky` does not.
const shots = (make: Make) => make('shots', {
  tools: [{
    id: 'shots',
    tools: [
      { type: 'function', function: { name: 'get_shots', description: 'The screenshots attached to an issue.', parameters: { type: 'object', properties: { one: { type: 'boolean' } } } }, returnsImages: true },
      { type: 'function', function: { name: 'sneaky', description: 'Images from a tool that did not say so.', parameters: { type: 'object', properties: {} } } },
    ],
    exec: async (name: string, args: Record<string, unknown>) => {
      const images = [{ bytes: A, name: 'a.png' }, { bytes: B, name: 'b.png' }];
      if (name === 'get_shots') return { text: 'Issue #7 has 2 screenshots', images: args.one ? images.slice(0, 1) : images };
      if (name === 'sneaky') return { text: 'look', images };
      throw new Error(`Unknown tool: ${name}`);
    },
  }],
});

const AI = { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', contextWindow: 1000, recall: { everyTurns: 0 } };
const under = { prompt_tokens: 100, completion_tokens: 10 };
const over = { prompt_tokens: 600, completion_tokens: 10 };

async function boot(model: ScriptedModel, ai: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const ui = await bootApp(model, 120, 36, (make) => [shots(make)], { ai: { ...AI, ...ai }, ...extra });
  await ui.press('F');
  return ui;
}
async function ask(ui: Awaited<ReturnType<typeof boot>>, model: ScriptedModel, text: string, requests: number) {
  await ui.type(text);
  await ui.press('return');
  await settleUntil(() => model.requests.length >= requests);
  await settle(8);
}

test('OpenAI wire: the text goes in the tool message and the images follow in a user message marked as the tool\'s; the chat shows a mark per image; later turns carry them until a batch stubs them, and recall brings one back', async () => {
  const model = new ScriptedModel();
  model.usage = under;
  model.script([{ tool: 'get_shots', args: {} }], [{ text: 'Two shots.' }], [{ text: 'Still here.' }], [{ text: 'Noted.' }]);
  const ui = await boot(model);
  await ask(ui, model, 'show me the shots', 2);
  const r1 = req(model, 1);
  const result = r1.messages.find((m) => m.role === 'tool')!;
  expect(result).toEqual({ role: 'tool', tool_call_id: 'call_0', content: 'OK: Issue #7 has 2 screenshots' });
  const after = r1.messages[r1.messages.indexOf(result) + 1]!;
  expect(after).toEqual({ role: 'user', content: [
    { type: 'text', text: '[2 images returned by get_shots — from the app, not a message from the person]' },
    { type: 'image_url', image_url: { url: url(A) } },
    { type: 'image_url', image_url: { url: url(B) } },
  ] });
  expect(after).toBe(r1.messages.at(-1)); // nothing after it: no screen tail with no plugin context
  // The chat: the answer, and under the opened trail one row per image — never the image.
  expect(ui.backend.lastFrame).toContain('Two shots.');
  expect(ui.backend.lastFrame).not.toContain('▣');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).toContain('▸ get_shots → ok');
  expect(ui.backend.lastFrame).toContain('▣ a.png · 400×300');
  expect(ui.backend.lastFrame).toContain('▣ b.png · 640×480');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle();

  // The next turn still carries them, as the person's own attachments would, and the
  // prefix is untouched.
  await ask(ui, model, 'and?', 3);
  isPrefix(r1, req(model, 2));
  expect(imageUrls(req(model, 2))).toEqual([url(A), url(B)]);

  // Past the threshold the turn's end stubs both: the next request names them in the
  // result's own text and carries no image; recall brings one back beside its result.
  model.usage = over;
  await ask(ui, model, 'more', 4);
  model.script([{ tool: 'recall', args: { id: idOf(A) } }], [{ text: 'Seen again.' }]);
  await ask(ui, model, 'look again', 6);
  const stubbed = req(model, 4);
  expect(imageUrls(stubbed)).toEqual([]);
  expect(JSON.stringify(stubbed)).not.toContain('base64');
  expect(stubbed.messages.find((m) => m.role === 'tool')!.content).toBe(`OK: Issue #7 has 2 screenshots\n[image a.png · 400×300 — recall("${idOf(A)}")]\n[image b.png · 640×480 — recall("${idOf(B)}")]`);
  const recalled = req(model, 5);
  const back = recalled.messages.filter((m) => m.role === 'tool').at(-1)!;
  expect(back.content).toBe(`OK: [recalled ${idOf(A)} — a.png · 400×300 — sent as an image beside this result, for this turn]`);
  expect(recalled.messages[recalled.messages.indexOf(back) + 1]).toEqual({ role: 'user', content: [
    { type: 'text', text: '[image returned by recall — from the app, not a message from the person]' },
    { type: 'image_url', image_url: { url: url(A) } },
  ] });
  expect(ui.backend.lastFrame).toContain('Seen again.');
  ui.app.unmount();
});

test('Anthropic wire: the images are image blocks inside the tool_result, which the API takes; the next turn carries the same block', async () => {
  const model = new ScriptedModel();
  model.wire = 'anthropic';
  model.script([{ tool: 'get_shots', args: {} }], [{ text: 'Seen.' }], [{ text: 'Still.' }]);
  const ui = await boot(model, { provider: 'anthropic', model: 'claude-sonnet-5' });
  type Block = Record<string, unknown> & { type: string };
  type Sent = { messages: { role: string; content: Block[] }[] };
  const sent = (i: number) => model.requests[i] as unknown as Sent;
  await ask(ui, model, 'show me', 2);
  const last = sent(1).messages.at(-1)!;
  expect(last.role).toBe('user');
  expect(last.content).toEqual([{
    type: 'tool_result',
    tool_use_id: 'toolu_0',
    content: [
      { type: 'text', text: 'OK: Issue #7 has 2 screenshots' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(A).toString('base64') } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(B).toString('base64') } },
    ],
    cache_control: { type: 'ephemeral' },
  }]);
  expect(ui.backend.lastFrame).toContain('Seen.');
  await ask(ui, model, 'and?', 3);
  const again = sent(2).messages.find((m) => m.content.some((b) => b.type === 'tool_result'))!;
  expect((again.content[0]!.content as Block[]).map((b) => b.type)).toEqual(['text', 'image', 'image']);
  ui.app.unmount();
});

test('size and count limits refuse with a note in the result text, never shrink, and send what fits', async () => {
  // Every fixture is 45 bytes: a 40-byte limit refuses both, by name and size.
  const big = new ScriptedModel();
  big.script([{ tool: 'get_shots', args: {} }], [{ text: 'None fit.' }]);
  let ui = await boot(big, { images: { maxBytes: 40 } });
  await ask(ui, big, 'show me', 2);
  expect(req(big, 1).messages.find((m) => m.role === 'tool')!.content).toBe(
    'OK: Issue #7 has 2 screenshots\n[image a.png not sent: 45 B — over the 40 B limit (ai.images.maxBytes); it is not shrunk to fit]\n[image b.png not sent: 45 B — over the 40 B limit (ai.images.maxBytes); it is not shrunk to fit]',
  );
  expect(imageUrls(req(big, 1))).toEqual([]);
  expect(req(big, 1).messages.at(-1)!.role).toBe('tool');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).not.toContain('▣');
  ui.app.unmount();

  // One per result: the first goes, the second is named as over the count.
  const many = new ScriptedModel();
  many.script([{ tool: 'get_shots', args: {} }], [{ text: 'One fit.' }]);
  ui = await boot(many, { images: { maxPerMessage: 1 } });
  await ask(ui, many, 'show me', 2);
  expect(req(many, 1).messages.find((m) => m.role === 'tool')!.content).toBe('OK: Issue #7 has 2 screenshots\n[image b.png not sent: over 1 image per result (ai.images.maxPerMessage)]');
  expect(imageUrls(req(many, 1))).toEqual([url(A)]);
  expect(textOf(req(many, 1).messages.at(-1)!.content)).toBe('[image returned by get_shots — from the app, not a message from the person]');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).toContain('▣ a.png · 400×300');
  expect(ui.backend.lastFrame).not.toContain('▣ b.png');
  ui.app.unmount();
});

test('a model that takes no images (ai.images.enabled false) gets the text and a note instead', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'get_shots', args: {} }], [{ text: 'Text only.' }]);
  const ui = await boot(model, { images: { enabled: false } });
  await ask(ui, model, 'show me', 2);
  expect(req(model, 1).messages.find((m) => m.role === 'tool')!.content).toBe('OK: Issue #7 has 2 screenshots\n[2 images not sent: images are off on this machine (ai.images.enabled is false)]');
  expect(imageUrls(req(model, 1))).toEqual([]);
  expect(JSON.stringify(model.requests)).not.toContain('base64');
  expect(ui.backend.lastFrame).toContain('Text only.');
  ui.app.unmount();
});

test('images from a tool that did not declare returnsImages are dropped: the text goes with a note, and the log says so', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'sneaky', args: {} }], [{ text: 'Dropped.' }]);
  const ui = await boot(model);
  await ask(ui, model, 'try', 2);
  expect(req(model, 1).messages.find((m) => m.role === 'tool')!.content).toBe('OK: look\n[2 images not sent: sneaky does not declare returnsImages]');
  expect(imageUrls(req(model, 1))).toEqual([]);
  expect(JSON.stringify(model.requests)).not.toContain('base64');
  expect(ui.backend.lastFrame).toContain('Dropped.');
  await ui.press('escape', 'escape');
  await ui.press('L');
  expect(ui.backend.lastFrame).toContain('[tools] sneaky: 2 images dropped — returnsImages not declared');
  ui.app.unmount();
});

test('the session keeps a ref into the host\'s store, never the bytes, and a restart reads the image back from it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-tool-images-sess-'));
  const first = new ScriptedModel();
  first.usage = under;
  first.script([{ tool: 'get_shots', args: { one: true } }], [{ text: 'One shot.' }]);
  const a = await boot(first, {}, { sessions: { dir } });
  await ask(a, first, 'show me', 2);
  await a.press('escape', 'escape'); // closing the chat saves at once
  a.app.unmount();
  const [name] = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  const raw = fs.readFileSync(path.join(dir, name!), 'utf8');
  expect(raw).not.toContain('base64');
  const saved = JSON.parse(raw) as { api: Array<{ role: string; images?: Array<{ n: number; name: string; path: string; sha256: string }> }> };
  const result = saved.api.find((m) => m.role === 'tool')!;
  expect(result.images).toHaveLength(1);
  const ref = result.images![0]!;
  expect(ref).toMatchObject({ n: 0, name: 'a.png', sha256: sha256(A), mime: 'image/png', bytes: A.length, width: 400, height: 300 });
  expect(ref.path).toBe(path.join(hostStateDir(), 'images', `${sha256(A)}.png`));
  expect(fs.readFileSync(ref.path)).toEqual(Buffer.from(A));

  const second = new ScriptedModel();
  second.usage = under;
  second.script([{ text: 'Back.' }]);
  const b = await boot(second, {}, { sessions: { dir } });
  await ask(b, second, 'again', 1);
  const r = req(second, 0);
  expect(r.messages.find((m) => m.role === 'tool')!.content).toBe('OK: Issue #7 has 2 screenshots');
  expect(imageUrls(r)).toEqual([url(A)]);
  expect(b.backend.lastFrame).toContain('Back.');
  b.app.unmount();
});
