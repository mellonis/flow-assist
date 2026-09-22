// Showing the model an image: attach it (a dropped path, /image, Ctrl+V, an empty
// paste), see its token in the field, send it as content parts — and keep it across a
// restart as a path and a hash, never as its bytes.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { png } from './helpers/image-fixtures';
import type { ClipboardImage } from '../assistant/images';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 100) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type Msg = { role: string; content: unknown };
const userMessages = (model: ScriptedModel, i: number) => (model.requests[i]!.messages as Msg[]).filter((m) => m.role === 'user');
const b64 = (file: string) => fs.readFileSync(file).toString('base64');
const imageUrls = (content: unknown) => (Array.isArray(content) ? content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url as string) : []);
const textOf = (content: unknown) => (Array.isArray(content) ? content.find((p) => p.type === 'text')?.text : content);

function fixtures() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-img-e2e-')));
  const one = path.join(dir, 'shot.png');
  const two = path.join(dir, 'My Shots', 'second shot.png');
  fs.mkdirSync(path.dirname(two));
  fs.writeFileSync(one, png(1000, 750));
  fs.writeFileSync(two, png(200, 100, 2));
  return { dir, one, two };
}

async function boot(model: ScriptedModel, extra: Record<string, unknown> = {}, opts: { clipboardImage?: () => ClipboardImage } = {}) {
  const ui = await bootApp(model, 110, 34, undefined, extra, opts);
  await ui.press('F');
  return ui;
}

test('a dropped path becomes [Image #1] in the field, and goes to the model as a content part', async () => {
  const { one } = fixtures();
  const model = new ScriptedModel();
  model.script([{ text: 'A screenshot.' }]);
  const ui = await boot(model);
  ui.backend.paste(`${one}`);
  await settle();
  expect(ui.backend.lastFrame).toContain('› [Image #1]');
  expect(ui.backend.lastFrame).not.toContain(one); // the path was not typed in
  // The token is drawn in a colour of its own — not the person's plain ink.
  const rows = ui.backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes('› [Image #1]'));
  const x = rows[y]!.indexOf('[Image #1]');
  const buf = (ui.backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { fg?: string } } } }).lastBuffer;
  await ui.type('what is this?');
  const typedX = ui.backend.lastFrame.split('\n')[y]!.indexOf('what');
  expect(buf.get(x, y).style.fg).toBeDefined();
  expect((ui.backend as unknown as { lastBuffer: typeof buf }).lastBuffer.get(x, y).style.fg).not.toBe((ui.backend as unknown as { lastBuffer: typeof buf }).lastBuffer.get(typedX, y).style.fg);
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  const [asked] = userMessages(model, 0);
  expect(asked!.content).toEqual([
    { type: 'text', text: '[Image #1] what is this?' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${b64(one)}` } },
  ]);
  await settle(5);
  // On screen, the message as typed — the token among it, in the token's colour.
  expect(ui.backend.lastFrame).toContain('› [Image #1] what is this?');
  const sentRows = ui.backend.lastFrame.split('\n');
  const sy = sentRows.findIndex((r) => r.includes('› [Image #1] what is this?'));
  const sx = sentRows[sy]!.indexOf('[Image #1]');
  const sent = (ui.backend as unknown as { lastBuffer: typeof buf }).lastBuffer;
  expect(sent.get(sx, sy).style.fg).toBe(buf.get(x, y).style.fg);
  expect(sent.get(sx, sy).style.fg).not.toBe(sent.get(sentRows[sy]!.indexOf('what'), sy).style.fg);
  ui.app.unmount();
});

test('Backspace right after the token takes it whole, and the image is not sent', async () => {
  const { one } = fixtures();
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await boot(model);
  ui.backend.paste(one);
  await settle();
  await ui.press('backspace'); // the space after the token
  await ui.press('backspace'); // the token, whole
  expect(ui.backend.lastFrame).not.toContain('[Image');
  expect(ui.backend.lastFrame).not.toContain('[Image #');
  await ui.type('just text');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  expect(userMessages(model, 0)[0]!.content).toBe('just text');
  ui.app.unmount();
});

test('two dropped files keep their order and numbers; numbering goes on across messages and restarts after /clear', async () => {
  const { one, two } = fixtures();
  const model = new ScriptedModel();
  model.script([{ text: 'first' }], [{ text: 'second' }], [{ text: 'third' }]);
  const ui = await boot(model);
  // A Finder drop of two files: each path escaped, separated by a space.
  ui.backend.paste(`${one.replace(/ /g, '\\ ')} ${two.replace(/ /g, '\\ ')}`);
  await settle();
  expect(ui.backend.lastFrame).toContain('› [Image #1] [Image #2]');
  await ui.type('compare');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  const first = userMessages(model, 0)[0]!.content;
  expect(textOf(first)).toBe('[Image #1] [Image #2] compare');
  expect(imageUrls(first)).toEqual([`data:image/png;base64,${b64(one)}`, `data:image/png;base64,${b64(two)}`]);
  await settle(5);

  // A quoted path (Finder, some terminals) — the next number, not 1 again.
  ui.backend.paste(`'${two}'`);
  await settle();
  expect(ui.backend.lastFrame).toContain('› [Image #3]');
  // The order sent is the order written, whatever order they were attached in.
  ui.backend.press({ name: 'home' });
  await settle();
  await ui.type('and [Image #1] vs ');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 2);
  const second = userMessages(model, 1);
  // The history still carries the first message's images.
  expect(imageUrls(second[0]!.content)).toHaveLength(2);
  expect(textOf(second[1]!.content)).toBe('and [Image #1] vs [Image #3]');
  expect(imageUrls(second[1]!.content)).toEqual([`data:image/png;base64,${b64(one)}`, `data:image/png;base64,${b64(two)}`]);
  await settle(5);

  await ui.type('/clear');
  await ui.press('return');
  ui.backend.paste(one);
  await settle();
  expect(ui.backend.lastFrame).toContain('› [Image #1]');
  ui.app.unmount();
});

test('↑ brings a sent message back with its image, and a hand-typed token is only text', async () => {
  const { one } = fixtures();
  const model = new ScriptedModel();
  model.script([{ text: 'one' }], [{ text: 'two' }], [{ text: 'three' }]);
  const ui = await boot(model);
  ui.backend.paste(one);
  await settle();
  await ui.type('look');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  await settle(5);
  await ui.press('up');
  expect(ui.backend.lastFrame).toContain('› [Image #1] look');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 2);
  const again = userMessages(model, 1).at(-1)!;
  expect(imageUrls(again.content)).toEqual([`data:image/png;base64,${b64(one)}`]);
  await settle(5);
  // Nothing stands behind #9: it is the person's text, sent as a string.
  await ui.type('see [Image #9]');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 3);
  expect(userMessages(model, 2).at(-1)!.content).toBe('see [Image #9]');
  ui.app.unmount();
});

test('the session keeps a path and a hash, never the bytes; a restart sends the image again; a file gone is said', async () => {
  const { one } = fixtures();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-img-sess-'));
  const first = new ScriptedModel();
  first.script([{ text: 'Seen.' }]);
  const a = await boot(first, { sessions: { dir } });
  a.backend.paste(one);
  await settle();
  await a.type('remember this');
  await a.press('return');
  await settleUntil(() => first.requests.length === 1);
  await settle(5);
  await a.press('escape', 'escape'); // closing the chat saves at once
  a.app.unmount();

  const [file] = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  const saved = fs.readFileSync(path.join(dir, file!), 'utf8');
  expect(saved).not.toContain('base64');
  expect(saved).not.toContain(b64(one));
  const s = JSON.parse(saved);
  expect(s.images).toHaveLength(1);
  expect(s.images[0]).toMatchObject({ n: 1, path: one, mime: 'image/png', bytes: fs.statSync(one).size });
  expect(s.images[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(s.imageSeq).toBe(1);
  expect(JSON.stringify(s.api)).toContain('"sha256"');

  // After a restart the history still carries the image, read again from its path.
  const second = new ScriptedModel();
  second.script([{ text: 'Still seen.' }]);
  const b = await boot(second, { sessions: { dir } });
  await b.type('and now?');
  await b.press('return');
  await settleUntil(() => second.requests.length === 1);
  const restored = userMessages(second, 0);
  expect(textOf(restored[0]!.content)).toBe('[Image #1] remember this');
  expect(imageUrls(restored[0]!.content)).toEqual([`data:image/png;base64,${b64(one)}`]);
  await settle(5);
  // Numbering goes on from the saved number.
  b.backend.paste(one);
  await settle();
  expect(b.backend.lastFrame).toContain('› [Image #2]');
  await b.press('escape', 'escape', 'escape'); // clear the field, then close
  b.app.unmount();

  // The file is gone: said in the chat, and the message goes as its text.
  fs.unlinkSync(one);
  const third = new ScriptedModel();
  third.script([{ text: 'Gone.' }]);
  const c = await boot(third, { sessions: { dir } });
  await c.type('still there?');
  await c.press('return');
  await settleUntil(() => third.requests.length === 1);
  await settle(5);
  expect(c.backend.lastFrame).toContain('Image #1 (shot.png) is no longer at');
  const gone = userMessages(third, 0)[0]!;
  expect(gone.content).toBe('[Image #1] remember this\n[image unavailable: shot.png]');
  expect(JSON.stringify(third.requests[0])).not.toContain('image_url');
  c.app.unmount();
});

test('with ai.images.enabled false a dropped path stays text, the reason is said, and nothing image-shaped is sent', async () => {
  const { one } = fixtures();
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await boot(model, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', images: { enabled: false } } });
  await ui.type('see ');
  ui.backend.paste(one);
  await settle();
  expect(ui.backend.lastFrame).toContain('images are off');
  expect(ui.backend.lastFrame).not.toContain('[Image #');
  expect(ui.backend.lastFrame).toContain('shot.png'); // the pasted path, as text
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  expect(userMessages(model, 0)[0]!.content).toBe(`see ${one}`);
  expect(JSON.stringify(model.requests[0])).not.toContain('image_url');
  // /image and Ctrl+V say the same.
  await ui.type('/image ');
  ui.backend.paste(one);
  await settle();
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('images are off');
  expect(ui.backend.lastFrame).not.toContain('[Image #');
  await ui.press('escape');
  ui.backend.press({ name: 'v', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).toContain('images are off');
  expect(ui.backend.lastFrame).not.toContain('[Image #');
  ui.app.unmount();
});

test('a file over the limit, or one image too many, is refused with the reason — never shrunk', async () => {
  const { one, two } = fixtures();
  const model = new ScriptedModel();
  const ui = await boot(model, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', images: { maxBytes: 40, maxPerMessage: 1 } } });
  ui.backend.paste(one);
  await settle();
  expect(ui.backend.lastFrame).toMatch(/shot\.png is \d+ B — over the 40 B limit/);
  expect(ui.backend.lastFrame).not.toContain('[Image #');
  await ui.press('escape'); // the path went in as text; clear it
  const small = path.join(path.dirname(one), 'tiny.gif');
  fs.writeFileSync(small, new Uint8Array([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([1, 0, 1, 0, 0, 0, 0, 0x3b])));
  ui.backend.paste(small);
  await settle();
  expect(ui.backend.lastFrame).toContain('› [Image #1]');
  ui.backend.paste(small);
  await settle();
  expect(ui.backend.lastFrame).toContain('a message carries at most 1 image');
  expect(ui.backend.lastFrame).not.toContain('[Image #2]');
  void two;
  ui.app.unmount();
});

test('/image <path> attaches a file; a path that is not an image is said', async () => {
  const { one, dir } = fixtures();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  const model = new ScriptedModel();
  const ui = await boot(model);
  await ui.type(`/image ${path.join(dir, 'notes.txt')}`);
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('notes.txt is not an image');
  await ui.press('escape');
  await ui.type(`/image ${path.join(dir, 'nope.png')}`);
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('no such file');
  await ui.press('escape');
  await ui.type('/image ');
  ui.backend.paste(`'${one}'`); // a path pasted after /image is the command's argument
  await settle();
  expect(ui.backend.lastFrame).toContain("› /image '/"); // the path went in as text
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('› [Image #1]');
  ui.app.unmount();
});

test('Ctrl+V and an empty paste take the clipboard image; a text paste stays text; an empty clipboard is a hint', async () => {
  const { one, two } = fixtures();
  let clip: ClipboardImage = { ok: true, path: one };
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await boot(model, {}, { clipboardImage: () => clip });
  ui.backend.press({ name: 'v', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).toContain('› [Image #1]');
  // What Cmd+V gives when the clipboard holds only an image: an empty paste.
  clip = { ok: true, path: two };
  ui.backend.paste('');
  await settle();
  expect(ui.backend.lastFrame).toContain('› [Image #1] [Image #2]');
  // Text on the clipboard is pasted as text, as always.
  ui.backend.paste('some words');
  await settle();
  expect(ui.backend.lastFrame).toContain('› [Image #1] [Image #2] some words');
  // Nothing on the clipboard: a short hint, the field as it was.
  clip = { ok: false, none: true, error: 'no image on the clipboard' };
  ui.backend.press({ name: 'v', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).toContain('no image on the clipboard');
  expect(ui.backend.lastFrame).toContain('› [Image #1] [Image #2] some words');
  expect(ui.backend.lastFrame).not.toContain('[Image #3]');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  expect(imageUrls(userMessages(model, 0)[0]!.content)).toEqual([`data:image/png;base64,${b64(one)}`, `data:image/png;base64,${b64(two)}`]);
  ui.app.unmount();
});

test('/compact sends the text only, and the image leaves the model\'s view with the history', async () => {
  const { one } = fixtures();
  const model = new ScriptedModel();
  model.script([{ text: 'A chart.' }], [{ text: 'SUMMARY: a chart was shown.' }], [{ text: 'Fine.' }]);
  const ui = await boot(model);
  ui.backend.paste(one);
  await settle();
  await ui.type('what is it?');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  await settle(5);
  await ui.type('/compact');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  const compact = JSON.stringify(model.requests[1]);
  expect(compact).not.toContain('image_url');
  expect(compact).not.toContain('base64');
  expect(compact).toContain('[image: shot.png]');
  await ui.type('next');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 3);
  expect(JSON.stringify(model.requests[2])).not.toContain('image_url');
  ui.app.unmount();
});

test('a provider that refuses the image is quoted once, with the switch that stops it', async () => {
  const { one } = fixtures();
  const model = new ScriptedModel();
  const ui = await boot(model);
  globalThis.fetch = (async () => new Response('{"error":{"message":"image_url is not supported by this model"}}', { status: 400 })) as unknown as typeof fetch;
  ui.backend.paste(one);
  await settle();
  await ui.type('see?');
  await ui.press('return');
  await settle(20);
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('The provider refused the image');
  expect(frame).toContain('image_url is not supported by this model');
  expect(frame).toContain('config set ai.images.enabled false');
  await ui.type('again');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame.split('The provider refused the image').length - 1).toBe(1);
  ui.app.unmount();
});

test('the context meter counts an attached image by its pixels', async () => {
  const { one } = fixtures();
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const ui = await boot(model, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', contextWindow: 100_000 } });
  ui.backend.paste(one);
  await settle();
  await ui.type('x');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  await settle(5);
  await ui.type('/context');
  await ui.press('return');
  // A 1000×750 image: 1000 tokens, on a line of its own.
  expect(ui.backend.lastFrame).toMatch(/images\s+1\.0k\s+1%/);
  ui.app.unmount();
});
