// Images the person attaches: what a file is (its bytes, not its name), how big it is
// drawn, what a paste of paths means, what is refused, and the clipboard's tools.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IMAGE_TOKENS_FALLBACK, contentText, imageLimits, imageTokenRanges, imageTokens, imagesInText, insertToken, isImageRefusal,
  loadImageFile, pastedPaths, readClipboardImage, readImageData, removeTokenAt, sha256, sniffImage, splitTokens, wireMessages,
  type ClipRun, type ImageRef,
} from '../assistant/images.js';
import { readContext } from '../assistant/context-meter.js';
import { gif, jpeg, png, webp } from './helpers/image-fixtures.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-img-')));

test('the magic bytes decide the kind, and the header gives the size', () => {
  expect(sniffImage(png(640, 480))).toEqual({ mime: 'image/png', width: 640, height: 480 });
  expect(sniffImage(jpeg(1024, 768))).toEqual({ mime: 'image/jpeg', width: 1024, height: 768 });
  expect(sniffImage(gif(32, 16))).toEqual({ mime: 'image/gif', width: 32, height: 16 });
  expect(sniffImage(webp('VP8X', 3000, 2000))).toEqual({ mime: 'image/webp', width: 3000, height: 2000 });
  expect(sniffImage(webp('VP8L', 300, 200))).toEqual({ mime: 'image/webp', width: 300, height: 200 });
  expect(sniffImage(webp('VP8 ', 120, 90))).toEqual({ mime: 'image/webp', width: 120, height: 90 });
  // Not an image, whatever it is called; a truncated header is still the kind, sizeless.
  expect(sniffImage(new TextEncoder().encode('just some text, not a picture'))).toBeNull();
  expect(sniffImage(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
  expect(sniffImage(png(1, 1).subarray(0, 8))).toEqual({ mime: 'image/png' });
});

test('an image costs tokens by its pixels, scaled as providers scale it', () => {
  expect(imageTokens({ width: 1000, height: 750 })).toBe(1000);
  expect(imageTokens({ width: 200, height: 200 })).toBe(54);
  // A 4K screenshot is scaled down first — it does not cost 11 000 tokens.
  const big = imageTokens({ width: 3840, height: 2160 });
  expect(big).toBeGreaterThan(1000);
  expect(big).toBeLessThanOrEqual(1534);
  expect(imageTokens({})).toBe(IMAGE_TOKENS_FALLBACK);
});

test('the context meter counts an image by its pixels, never by the text of its ref', () => {
  const ref: ImageRef = { n: 1, name: 'a.png', path: '/x/a.png', sha256: 'f'.repeat(64), mime: 'image/png', bytes: 5_000_000, width: 1000, height: 750 };
  const r = readContext({ system: '', memory: '', plan: '', summary: '', tools: [], messages: [{ role: 'user', content: 'look', images: [ref] }] }, 100_000);
  expect(r.parts.find((p) => p.label === 'images')?.tokens).toBe(1000);
  const text = r.parts.find((p) => p.label === 'messages')!.tokens;
  expect(text).toBeLessThan(20); // the ref's path and hash are not counted as text
});

test('a pasted path: bare, quoted, escaped, ~, a file URL, several — and text that only contains one', () => {
  expect(pastedPaths('/Users/me/shot.png')).toEqual([['/Users/me/shot.png']]);
  expect(pastedPaths("'/Users/me/My Shots/shot 1.png' ")).toEqual([['/Users/me/My Shots/shot 1.png']]);
  expect(pastedPaths('/Users/me/My\\ Shots/shot\\ 1.png')).toEqual([['/Users/me/My Shots/shot 1.png']]);
  expect(pastedPaths('~/Desktop/a.png')).toEqual([['~/Desktop/a.png']]);
  expect(pastedPaths('file:///Users/me/My%20Shot.png')).toEqual([['/Users/me/My Shot.png']]);
  // A name with spaces pasted bare: the whole paste first, then word by word.
  expect(pastedPaths('/tmp/My Shot.png')).toEqual([['/tmp/My Shot.png']]);
  expect(pastedPaths('/a/one.png /b/two\\ 2.png')).toEqual([['/a/one.png', '/b/two 2.png']]);
  expect(pastedPaths('/a/one.png /b/two.png')).toEqual([['/a/one.png /b/two.png'], ['/a/one.png', '/b/two.png']]);
  expect(pastedPaths('/a/one.png\n/b/two.png')).toEqual([['/a/one.png', '/b/two.png']]);
  // An apostrophe in a name: bare, it is part of the name; escaped or quoted, spelling.
  expect(pastedPaths("/tmp/Don't Panic.png")).toEqual([["/tmp/Don't Panic.png"]]);
  expect(pastedPaths("/tmp/Don\\'t\\ Panic.png")).toEqual([["/tmp/Don't Panic.png"]]);
  expect(pastedPaths(`"/tmp/Don't Panic.png"`)).toEqual([["/tmp/Don't Panic.png"]]);
  // Text that merely has a path in it is not a path.
  expect(pastedPaths('look at /a/one.png please')).toEqual([]);
  expect(pastedPaths('screenshot.png')).toEqual([]);
  expect(pastedPaths('')).toEqual([]);
  // `/image` names a file on purpose: any word is a path there.
  expect(pastedPaths('screenshot.png', { anyPath: true })).toEqual([['screenshot.png']]);
});

test('loading: a real path, a missing file, not an image, too big — each said', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'shot.png'), png(10, 20));
  fs.writeFileSync(path.join(dir, 'fake.png'), 'not an image at all');
  fs.symlinkSync(path.join(dir, 'shot.png'), path.join(dir, 'link.png'));
  const ok = loadImageFile('link.png', dir, 1000);
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(ok.ref.path).toBe(path.join(dir, 'shot.png')); // the target, not the link
    expect(ok.ref.name).toBe('link.png');
    expect(ok.ref).toMatchObject({ mime: 'image/png', width: 10, height: 20, bytes: png(10, 20).length, sha256: sha256(png(10, 20)) });
  }
  const missing = loadImageFile(path.join(dir, 'gone.png'), dir, 1000);
  expect(missing).toMatchObject({ ok: false, reason: 'missing' });
  const fake = loadImageFile(path.join(dir, 'fake.png'), dir, 1000);
  expect(fake).toMatchObject({ ok: false, reason: 'not-an-image' });
  if (!fake.ok) expect(fake.error).toContain('not an image');
  const big = loadImageFile(path.join(dir, 'shot.png'), dir, 10);
  expect(big).toMatchObject({ ok: false, reason: 'too-big' });
  if (!big.ok) expect(big.error).toMatch(/over the 10 B limit \(ai\.images\.maxBytes\)/);
  expect(loadImageFile(dir, dir, 1000)).toMatchObject({ ok: false, reason: 'not-a-file' });
});

test('a saved ref reads back only while the file is the one attached', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, png(4, 4));
  const ref: ImageRef = { n: 1, name: 'a.png', path: file, sha256: sha256(png(4, 4)), mime: 'image/png', bytes: 1 };
  expect(readImageData(ref).ok).toBe(true);
  fs.writeFileSync(file, png(4, 4, 7));
  expect(readImageData(ref)).toEqual({ ok: false, why: 'changed' });
  fs.unlinkSync(file);
  expect(readImageData(ref)).toEqual({ ok: false, why: 'missing' });
});

test('the limits: on by default, 5 MB, 4 a message', () => {
  expect(imageLimits(undefined)).toEqual({ enabled: true, maxBytes: 5 * 1024 * 1024, maxPerMessage: 4 });
  expect(imageLimits({ images: { enabled: false, maxBytes: 10, maxPerMessage: 1 } })).toEqual({ enabled: false, maxBytes: 10, maxPerMessage: 1 });
  expect(imageLimits({ images: { maxBytes: -3 } }).maxBytes).toBe(5 * 1024 * 1024);
});

test('tokens: inserted at the caret with a space after, removed whole, sent in the order written', () => {
  expect(insertToken('see  now', 4, 1)).toEqual({ value: 'see [Image #1] now', cursor: 14 });
  expect(insertToken('', 0, 2)).toEqual({ value: '[Image #2] ', cursor: 11 });
  const known = (n: number) => n === 1 || n === 2;
  expect(removeTokenAt('a [Image #1] b', 12, 'back', known)).toEqual({ value: 'a  b', cursor: 2 });
  expect(removeTokenAt('a [Image #1] b', 2, 'forward', known)).toEqual({ value: 'a  b', cursor: 2 });
  expect(removeTokenAt('a [Image #1] b', 11, 'back', known)).toBeNull(); // inside it: the editor's key
  expect(removeTokenAt('a [Image #9] b', 12, 'back', known)).toBeNull(); // nothing behind it
  const refs = new Map([1, 2].map((n) => [n, { n, name: `${n}.png`, path: `/${n}.png`, sha256: String(n), mime: 'image/png', bytes: 1 } as ImageRef]));
  expect(imagesInText('compare [Image #2] with [Image #1] and [Image #2] and [Image #9]', refs).map((r) => r.n)).toEqual([2, 1]);
  expect(imageTokenRanges('x [Image #9]', known)).toEqual([]);
  expect(splitTokens('ab[Image #1]cd', 10, [{ start: 12, end: 22 }])).toEqual([{ text: 'ab', token: false }, { text: '[Image #1]', token: true }, { text: 'cd', token: false }]);
  // A row that begins inside a wrapped token draws its part of the token.
  expect(splitTokens('#1] x', 7, [{ start: 0, end: 10 }])).toEqual([{ text: '#1]', token: true }, { text: ' x', token: false }]);
});

test('the wire: text first, then the images; one that cannot be read is named in the text', () => {
  const a: ImageRef = { n: 1, name: 'a.png', path: '/a.png', sha256: 'a', mime: 'image/png', bytes: 1 };
  const b: ImageRef = { n: 2, name: 'b.png', path: '/b.png', sha256: 'b', mime: 'image/png', bytes: 1 };
  const out = wireMessages(
    [{ role: 'system', content: 'sys' }, { role: 'user', content: '[Image #1] [Image #2] what?', images: [a, b] }],
    (r) => (r.n === 1 ? { ok: true, url: 'data:image/png;base64,QQ==' } : { ok: false, why: 'missing' }),
  );
  expect(out[0]).toEqual({ role: 'system', content: 'sys' });
  expect(out[1]).toEqual({ role: 'user', content: [{ type: 'text', text: '[Image #1] [Image #2] what?\n[image unavailable: b.png]' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }] });
  expect('images' in out[1]!).toBe(false);
  // None could be read: the content stays a string.
  const none = wireMessages([{ role: 'user', content: 'x', images: [a] }], () => ({ ok: false, why: 'off' }));
  expect(none[0]).toEqual({ role: 'user', content: 'x\n[image not sent: a.png]' });
  expect(contentText(out[1]!.content)).toBe('[Image #1] [Image #2] what?\n[image unavailable: b.png]\n[image]');
});

test('a provider refusal is about the image only when it says so', () => {
  expect(isImageRefusal('LLM 400: {"error":"image_url is not supported for this model"}')).toBe(true);
  expect(isImageRefusal('LLM 400: Invalid content part type')).toBe(true);
  expect(isImageRefusal('LLM 400: context length exceeded')).toBe(false);
  expect(isImageRefusal('LLM 500: image service down')).toBe(false);
});

test('the clipboard: pngpaste, then osascript on a Mac; wl-paste, then xclip on Linux; a missing tool is named', () => {
  const dir = tmp();
  const calls: string[] = [];
  // pngpaste installed and holding an image: it writes the file named in its argument.
  const withPngpaste: ClipRun = (cmd, args) => { calls.push(cmd); if (cmd === 'pngpaste') { fs.writeFileSync(args[0]!, png(2, 2)); return { ok: true }; } return { ok: false }; };
  const mac = readClipboardImage('darwin', withPngpaste, dir);
  expect(mac.ok).toBe(true);
  if (mac.ok) expect(sniffImage(fs.readFileSync(mac.path))?.mime).toBe('image/png');
  expect(calls).toEqual(['pngpaste']);
  // pngpaste installed, clipboard holds text: no image, and osascript is not asked.
  expect(readClipboardImage('darwin', (cmd) => (cmd === 'pngpaste' ? { ok: false } : { ok: true }), dir)).toEqual({ ok: false, none: true, error: 'no image on the clipboard' });
  // No pngpaste: AppleScript writes the file, or fails when there is no image.
  const osa: ClipRun = (cmd, args) => {
    if (cmd === 'pngpaste') return { ok: false, missing: true };
    const target = /POSIX file "(.*?)"/.exec(args.join(' '))![1]!;
    fs.writeFileSync(target, png(3, 3));
    return { ok: true };
  };
  expect(readClipboardImage('darwin', osa, dir).ok).toBe(true);
  expect(readClipboardImage('darwin', (cmd) => (cmd === 'pngpaste' ? { ok: false, missing: true } : { ok: false }), dir)).toMatchObject({ ok: false, none: true });
  // Linux: the image comes on stdout.
  const wl: ClipRun = (cmd) => (cmd === 'wl-paste' ? { ok: true, stdout: png(5, 5) } : { ok: false, missing: true });
  const lin = readClipboardImage('linux', wl, dir);
  expect(lin.ok).toBe(true);
  const xclipOnly: ClipRun = (cmd) => (cmd === 'xclip' ? { ok: true, stdout: png(6, 6) } : { ok: false, missing: true });
  expect(readClipboardImage('linux', xclipOnly, dir).ok).toBe(true);
  const neither = readClipboardImage('linux', () => ({ ok: false, missing: true }), dir);
  expect(neither).toMatchObject({ ok: false });
  if (!neither.ok) { expect(neither.error).toContain('wl-paste'); expect(neither.error).toContain('xclip'); expect(neither.none).toBeUndefined(); }
  expect(readClipboardImage('linux', (cmd) => (cmd === 'wl-paste' ? { ok: false } : { ok: false, missing: true }), dir)).toMatchObject({ ok: false, none: true });
  expect(readClipboardImage('win32', () => ({ ok: true }), dir)).toMatchObject({ ok: false });
});
