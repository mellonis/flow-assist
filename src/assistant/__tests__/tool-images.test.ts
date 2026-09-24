// An image a tool returns beside its text: read off the return value, told by its
// bytes, held to the person's limits, written once into the host's own store, and
// kept as a ref. What is refused is said in a note the model reads.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IMAGE_DEFAULTS, sha256, type ImageLimits } from '../images';
import { IMAGE_STORE_KEEP, acceptToolImages, imageMark, markText, pruneImageStore, toolImageResult } from '../tool-images';
import { png, jpeg } from '../../__tests__/helpers/image-fixtures';

const limits: ImageLimits = { ...IMAGE_DEFAULTS };
const store = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-tool-images-'));
const accept = (images: unknown[], over: Partial<Parameters<typeof acceptToolImages>[1]> = {}) =>
  acceptToolImages(images as never, { declared: true, limits, dir: store(), tool: 'get_issue', ...over });

test('a return value is an image result only in the shape { text, images[] }; anything else is a plain result', () => {
  expect(toolImageResult('just text')).toBeNull();
  expect(toolImageResult({ text: 'no images key' })).toBeNull();
  expect(toolImageResult({ text: 'x', images: 'nope' })).toBeNull();
  expect(toolImageResult(null)).toBeNull();
  expect(toolImageResult({ text: 'two', images: [{ bytes: png(4, 4) }, { base64: 'AAAA' }] })).toEqual({ text: 'two', images: [{ bytes: png(4, 4) }, { base64: 'AAAA' }] });
  // Text is optional — a tool that has only images to show; a non-string text reads as ''.
  expect(toolImageResult({ images: [] })).toEqual({ text: '', images: [] });
  expect(toolImageResult({ text: 42, images: [] })).toEqual({ text: '', images: [] });
});

test('an accepted image is told by its bytes, stored once by its hash, and comes back as a ref, a data URL and a mark', () => {
  const dir = store();
  const data = png(400, 300);
  const r = acceptToolImages([{ bytes: data, name: 'shot.png', mime: 'image/jpeg' /* the bytes say png; the claim is ignored */ }], { declared: true, limits, dir, tool: 'get_issue' });
  expect(r.notes).toEqual([]);
  expect(r.refs).toHaveLength(1);
  const ref = r.refs[0]!;
  const hash = sha256(data);
  expect(ref).toEqual({ n: 0, name: 'shot.png', path: path.join(dir, `${hash}.png`), sha256: hash, mime: 'image/png', bytes: data.length, width: 400, height: 300 });
  expect(fs.readFileSync(ref.path)).toEqual(Buffer.from(data));
  expect(fs.statSync(ref.path).mode & 0o777).toBe(0o600);
  expect(r.urls.get(hash)).toBe(`data:image/png;base64,${Buffer.from(data).toString('base64')}`);
  expect(r.marks).toEqual([{ name: 'shot.png', width: 400, height: 300 }]);
  // The same bytes again: the same file, not a second one.
  acceptToolImages([{ bytes: data, name: 'again.png' }], { declared: true, limits, dir, tool: 'get_issue' });
  expect(fs.readdirSync(dir)).toEqual([`${hash}.png`]);
});

test('base64 is taken too, a missing name is made from the kind, and an ArrayBuffer works', () => {
  const data = jpeg(20, 10);
  const r = accept([{ base64: Buffer.from(data).toString('base64') }, { bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }]);
  expect(r.notes).toEqual([]);
  expect(r.refs.map((x) => x.name)).toEqual(['image-1.jpg', 'image-2.jpg']);
  expect(r.refs[0]!.mime).toBe('image/jpeg');
  expect(r.refs[0]!.width).toBe(20);
});

test('what is not an image, has no bytes, or is not an object is refused with a note and nothing stored', () => {
  const dir = store();
  const r = acceptToolImages([{ bytes: new TextEncoder().encode('hello'), name: 'x.bin' }, { name: 'empty.png' }, 'junk', { base64: '@@@' }] as never, { declared: true, limits, dir, tool: 'get_issue' });
  expect(r.refs).toEqual([]);
  expect(r.notes).toEqual([
    '[image x.bin not sent: not an image (png, jpeg, gif or webp)]',
    '[image empty.png not sent: no bytes or base64]',
    '[image 3 not sent: not an image object]',
    '[image 4 not sent: not an image (png, jpeg, gif or webp)]',
  ]);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('over ai.images.maxBytes is refused, never shrunk — a base64 too long to fit is refused before it is decoded', () => {
  const small = { ...limits, maxBytes: 40 };
  const data = png(4, 4); // 45 bytes
  const r = accept([{ bytes: data, name: 'big.png' }, { base64: Buffer.from(data).toString('base64'), name: 'big64.png' }, { bytes: png(1, 1).subarray(0, 33), name: 'ok.png' }], { limits: small });
  expect(r.notes).toEqual([
    '[image big.png not sent: 45 B — over the 40 B limit (ai.images.maxBytes); it is not shrunk to fit]',
    '[image big64.png not sent: 45 B — over the 40 B limit (ai.images.maxBytes); it is not shrunk to fit]',
  ]);
  expect(r.refs.map((x) => x.name)).toEqual(['ok.png']);
});

test('past ai.images.maxPerMessage the rest are refused by count, each named', () => {
  const r = accept([{ bytes: png(1, 1, 1), name: 'a.png' }, { bytes: png(1, 1, 2), name: 'b.png' }, { bytes: png(1, 1, 3), name: 'c.png' }], { limits: { ...limits, maxPerMessage: 2 } });
  expect(r.refs.map((x) => x.name)).toEqual(['a.png', 'b.png']);
  expect(r.notes).toEqual(['[image c.png not sent: over 2 images per result (ai.images.maxPerMessage)]']);
});

test('with images off every image is dropped and the text says so in one line; a tool that did not declare returnsImages is refused the same way', () => {
  const dir = store();
  const off = acceptToolImages([{ bytes: png(1, 1, 1) }, { bytes: png(1, 1, 2) }], { declared: true, limits: { ...limits, enabled: false }, dir, tool: 'get_issue' });
  expect(off.refs).toEqual([]);
  expect(off.notes).toEqual(['[2 images not sent: images are off on this machine (ai.images.enabled is false)]']);
  const undeclared = acceptToolImages([{ bytes: png(1, 1, 1) }], { declared: false, limits, dir, tool: 'get_issue' });
  expect(undeclared.refs).toEqual([]);
  expect(undeclared.notes).toEqual(['[1 image not sent: get_issue does not declare returnsImages]']);
  expect(fs.readdirSync(dir)).toEqual([]); // nothing is stored for a refused image
  expect(acceptToolImages([], { declared: false, limits, dir, tool: 'get_issue' }).notes).toEqual([]); // no images, nothing to say
});

test('the store is bounded: past the keep count the oldest files go, and only image files are touched', () => {
  const dir = store();
  for (let i = 0; i < IMAGE_STORE_KEEP + 3; i++) {
    const f = path.join(dir, `${'0'.repeat(60)}${String(i).padStart(4, '0')}.png`);
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, new Date(1_700_000_000_000 + i * 1000), new Date(1_700_000_000_000 + i * 1000));
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'kept');
  pruneImageStore(dir);
  const left = fs.readdirSync(dir).sort();
  expect(left).toHaveLength(IMAGE_STORE_KEEP + 1);
  expect(left).toContain('notes.txt');
  expect(left).not.toContain(`${'0'.repeat(60)}0000.png`);
  expect(left).not.toContain(`${'0'.repeat(60)}0002.png`);
  expect(left).toContain(`${'0'.repeat(60)}0003.png`);
  // A directory that does not exist is nothing to prune.
  expect(() => pruneImageStore(path.join(dir, 'nope'))).not.toThrow();
});

test('the mark is one row: the glyph, the name and the size when known', () => {
  expect(markText(imageMark({ name: 'shot.png', width: 400, height: 300 }))).toBe('▣ shot.png · 400×300');
  expect(markText(imageMark({ name: 'blob.gif' }))).toBe('▣ blob.gif');
});
