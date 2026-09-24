// Images a tool returns to the model — an issue's screenshots, a design, a chart.
//
// The person's rule stands: text the model read must never make the host read a
// file as an image. A tool that fetched an image ITSELF may hand it over, as bytes
// beside its text — `{ text, images: [{ bytes | base64, name }] }` — and the host
// never opens a path or a URL named in text. The images are data, like any result.
//
// What the host does with them, in order: a tool that did not declare
// `returnsImages` on its def has them dropped; with `ai.images.enabled` false they are
// dropped; each is told by its bytes (`sniffImage` — the tool's `mime` is a claim and
// is not read), held under `ai.images.maxBytes` (refused, never shrunk) and counted
// under `ai.images.maxPerMessage` per result. Every refusal is one line the model
// reads at the end of the result's text (`notes`).
//
// An accepted image is written ONCE into the host's own store — `images/<sha256>.<ext>`
// under `hostStateDir()` (src/config/load.ts), resolved on every call and never at
// import — and kept as an `ImageRef` pointing there (src/assistant/images.ts): the
// session and the model's history hold the ref, never the bytes, and the same
// hash-checked re-read that serves an attached image after a restart serves this one,
// and `recall`. **What prunes the store:** `pruneImageStore`, after every write —
// a cap by COUNT, `IMAGE_STORE_KEEP` files, the oldest by mtime removed first. A ref
// whose file was pruned reads as `[image unavailable: name]` on the wire and is
// `recall`'s own answer, the same as an attachment deleted from disk.
//
// Pure except `acceptToolImages` (writes the store) and `pruneImageStore`.
import fs from 'node:fs';
import path from 'node:path';
import { hostStateDir } from '../config/load.js';
import { dataUrl, fmtBytes, sha256, sniffImage, type ImageLimits, type ImageRef } from './images.js';

// One image as a tool returns it. `bytes` (a Uint8Array — a Buffer is one — or an
// ArrayBuffer) or `base64`; `name` is for the person and the model, `mime` is ignored.
export interface ToolImage { bytes?: Uint8Array | ArrayBuffer; base64?: string; mime?: string; name?: string }
// The return value that carries images: `images` is what makes it one.
export interface ToolImageResult { text: string; images: ToolImage[] }

// Reads a tool's return value as an image result, or null for anything else (a
// string, an object without `images`) — those are results as they always were.
export function toolImageResult(v: unknown): ToolImageResult | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as { text?: unknown; images?: unknown };
  if (!Array.isArray(r.images)) return null;
  return { text: typeof r.text === 'string' ? r.text : '', images: r.images as ToolImage[] };
}

// What the chat draws for a returned image: one row, never the image.
export interface ImageMark { name: string; width?: number; height?: number }
export const IMAGE_MARK = '▣';
export function imageMark(ref: { name: string; width?: number; height?: number }): ImageMark {
  return { name: ref.name, ...(ref.width && ref.height ? { width: ref.width, height: ref.height } : {}) };
}
export function markText(m: ImageMark): string {
  return `${IMAGE_MARK} ${m.name}${m.width && m.height ? ` · ${m.width}×${m.height}` : ''}`;
}
// A mark read back from a session file — anything else in its place is dropped.
export function isImageMark(v: unknown): v is ImageMark {
  const m = v as Partial<ImageMark> | null;
  return !!m && typeof m === 'object' && typeof m.name === 'string';
}

// ─── The store ────────────────────────────────────────────────────────────────
export const IMAGE_STORE_KEEP = 200;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const STORED = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;

// Where returned images live. Resolved on every call: under `bun test` the state dir
// is a temporary directory of the process (src/config/load.ts).
export const imageStoreDir = (): string => path.join(hostStateDir(), 'images');

// The oldest files past the cap go. Only the store's own files are touched — a name
// that is not `<sha256>.<ext>` is not the store's to remove.
export function pruneImageStore(dir: string, keep = IMAGE_STORE_KEEP): void {
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => STORED.test(n)); } catch { return; }
  if (names.length <= keep) return;
  const dated = names.map((name) => { try { return { name, at: fs.statSync(path.join(dir, name)).mtimeMs }; } catch { return null; } }).filter((x): x is { name: string; at: number } => x !== null);
  dated.sort((a, b) => a.at - b.at);
  for (const { name } of dated.slice(0, Math.max(0, dated.length - keep))) {
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* gone already, or not ours to remove */ }
  }
}

// Writes `data` as `<dir>/<hash>.<ext>` unless that file is there already (content-
// addressed: the same bytes are one file). A temp file and a rename, so a crash never
// leaves a half-written image that would then read as "changed".
function storeImage(dir: string, hash: string, mime: string, data: Uint8Array): string {
  const file = path.join(dir, `${hash}.${EXT[mime] ?? 'bin'}`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
  pruneImageStore(dir);
  return file;
}

// ─── Accepting what a tool returned ───────────────────────────────────────────
export interface AcceptedImages {
  refs: ImageRef[]; // what the result keeps — `n` is 0: a tool's image has no `[Image #N]` token
  urls: Map<string, string>; // sha256 → the `data:` URL for THIS turn's rounds
  marks: ImageMark[]; // what the chat draws
  notes: string[]; // one line per refusal, for the end of the result's text
}

const bytesOf = (img: ToolImage): Uint8Array | null => {
  if (img.bytes instanceof Uint8Array) return img.bytes;
  if (img.bytes instanceof ArrayBuffer) return new Uint8Array(img.bytes);
  if (typeof img.base64 === 'string' && img.base64) return new Uint8Array(Buffer.from(img.base64, 'base64'));
  return null;
};
// A base64 string's decoded size, without decoding it — a limit is checked before a
// large allocation, not after.
const base64Bytes = (s: string): number => Math.floor((s.replace(/[^A-Za-z0-9+/]/g, '').length * 3) / 4);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function acceptToolImages(images: ToolImage[], opts: { declared: boolean; limits: ImageLimits; dir: string; tool: string }): AcceptedImages {
  const out: AcceptedImages = { refs: [], urls: new Map(), marks: [], notes: [] };
  if (!images.length) return out;
  // The two whole-result refusals first, one line each: nothing is read or stored.
  if (!opts.declared) { out.notes.push(`[${plural(images.length, 'image')} not sent: ${opts.tool} does not declare returnsImages]`); return out; }
  if (!opts.limits.enabled) { out.notes.push(`[${plural(images.length, 'image')} not sent: images are off on this machine (ai.images.enabled is false)]`); return out; }
  const refuse = (name: string, why: string) => out.notes.push(`[image ${name} not sent: ${why}]`);
  images.forEach((img, i) => {
    const fallback = `image ${i + 1}`;
    if (!img || typeof img !== 'object') { refuse(fallback.replace('image ', ''), 'not an image object'); return; }
    const named = typeof img.name === 'string' && img.name.trim() ? img.name.trim() : '';
    const label = named || String(i + 1);
    if (img.bytes == null && !(typeof img.base64 === 'string' && img.base64)) { refuse(label, 'no bytes or base64'); return; }
    const overLimit = (n: number) => refuse(label, `${fmtBytes(n)} — over the ${fmtBytes(opts.limits.maxBytes)} limit (ai.images.maxBytes); it is not shrunk to fit`);
    if (img.bytes == null && typeof img.base64 === 'string' && base64Bytes(img.base64) > opts.limits.maxBytes) { overLimit(base64Bytes(img.base64)); return; }
    const data = bytesOf(img);
    const kind = data ? sniffImage(data) : null;
    if (!data || !kind) { refuse(label, 'not an image (png, jpeg, gif or webp)'); return; }
    if (data.length > opts.limits.maxBytes) { overLimit(data.length); return; }
    if (out.refs.length >= opts.limits.maxPerMessage) { refuse(label, `over ${plural(opts.limits.maxPerMessage, 'image')} per result (ai.images.maxPerMessage)`); return; }
    const hash = sha256(data);
    let file: string;
    try { file = storeImage(opts.dir, hash, kind.mime, data); } catch (e) { refuse(label, `could not be stored: ${e instanceof Error ? e.message : String(e)}`); return; }
    const name = named || `image-${i + 1}.${EXT[kind.mime] ?? 'bin'}`;
    const ref: ImageRef = { n: 0, name, path: file, sha256: hash, mime: kind.mime, bytes: data.length, ...(kind.width ? { width: kind.width, height: kind.height } : {}) };
    out.refs.push(ref);
    out.urls.set(hash, dataUrl(kind.mime, data));
    out.marks.push(imageMark(ref));
  });
  return out;
}
