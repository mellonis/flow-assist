// Images the person shows the model — a screenshot of a failing screen, a design mock.
//
// The person decides what leaves the machine: an image is read only when THEY attach
// it (a dropped or pasted path, `/image <path>`, `/image` or Ctrl+V for the clipboard).
// Nothing the model says can make the host read a file as an image.
//
// An attachment is a token in the field's text, `[Image #N]`, with the file behind it
// in a map the conversation owns. N counts up for the whole conversation and never
// restarts in it — image 1 stays image 1 ten messages later — so the TEXT decides what
// is sent: the tokens it holds, in order, that the map knows. A token edited away is
// not sent; one typed by hand with nothing behind it is just text.
//
// What is kept of an image is its saved form, `ImageRef` — the path, a hash, the type
// and the size — never its bytes. The model's history and the session file hold the
// ref; the `data:` URL is built only on the way to the provider (`wireMessages`),
// after the file is read again and its hash checked. A file gone or changed since is
// said in the chat, and that message goes as its text plus `[image unavailable: …]`.
//
// Pure, except `loadImageFile` / `readImageData` (the file system) and
// `readClipboardImage` (the platform's clipboard tools, through an injectable runner).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from './agent.js';

export interface ImageRef {
  n: number; // the token's number, `[Image #n]`
  name: string; // the file's name, for the person and for `[image: name]`
  path: string; // the REAL path it was read from
  sha256: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────
// `ai.images`: on by default — the models people run here take images, and the API
// cannot be asked whether one does. `config set ai.images.enabled false` on a
// machine whose model cannot: attaching is then refused before anything is sent,
// and an image already in the conversation goes as its name only.
export const IMAGE_DEFAULTS = { enabled: true, maxBytes: 5 * 1024 * 1024, maxPerMessage: 4 };
export interface ImageLimits { enabled: boolean; maxBytes: number; maxPerMessage: number }
export function imageLimits(ai: unknown): ImageLimits {
  const c = ((ai as { images?: unknown } | undefined)?.images ?? {}) as Record<string, unknown>;
  const pos = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : d);
  return {
    enabled: c.enabled !== false,
    maxBytes: pos(c.maxBytes, IMAGE_DEFAULTS.maxBytes),
    maxPerMessage: pos(c.maxPerMessage, IMAGE_DEFAULTS.maxPerMessage),
  };
}

// ─── What a file is: magic bytes, not the extension ───────────────────────────
export interface Sniffed { mime: string; width?: number; height?: number }

const at = (b: Uint8Array, i: number) => b[i] ?? 0;
const be16 = (b: Uint8Array, i: number) => (at(b, i) << 8) | at(b, i + 1);
const le16 = (b: Uint8Array, i: number) => at(b, i) | (at(b, i + 1) << 8);
const be32 = (b: Uint8Array, i: number) => at(b, i) * 0x1000000 + (at(b, i + 1) << 16) + (at(b, i + 2) << 8) + at(b, i + 3);
const le24 = (b: Uint8Array, i: number) => at(b, i) | (at(b, i + 1) << 8) | (at(b, i + 2) << 16);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
const dims = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : {});

// JPEG keeps its size in the first start-of-frame segment, after whatever EXIF and
// tables come first; the segments are walked by their lengths.
function jpegSize(b: Uint8Array): { width?: number; height?: number } {
  let i = 2;
  while (i + 9 < b.length) {
    if (at(b, i) !== 0xff) return {};
    const marker = at(b, i + 1);
    if (marker === 0xff) { i++; continue; } // fill bytes
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) return dims(be16(b, i + 7), be16(b, i + 5));
    i += 2 + be16(b, i + 2);
  }
  return {};
}

function webpSize(b: Uint8Array): { width?: number; height?: number } {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && at(b, 23) === 0x9d && at(b, 24) === 0x01 && at(b, 25) === 0x2a) return dims(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  if (chunk === 'VP8L' && at(b, 20) === 0x2f) {
    return dims(1 + (((at(b, 22) & 0x3f) << 8) | at(b, 21)), 1 + (((at(b, 24) & 0x0f) << 10) | (at(b, 23) << 2) | ((at(b, 22) & 0xc0) >> 6)));
  }
  if (chunk === 'VP8X') return dims(1 + le24(b, 24), 1 + le24(b, 27));
  return {};
}

// null — not one of the four kinds a provider takes (png, jpeg, gif, webp).
export function sniffImage(b: Uint8Array): Sniffed | null {
  if (b.length >= 8 && at(b, 0) === 0x89 && ascii(b, 1, 3) === 'PNG' && at(b, 4) === 0x0d && at(b, 5) === 0x0a && at(b, 6) === 0x1a && at(b, 7) === 0x0a) {
    const size = ascii(b, 12, 4) === 'IHDR' ? dims(be32(b, 16), be32(b, 20)) : {};
    return { mime: 'image/png', ...size };
  }
  if (b.length >= 3 && at(b, 0) === 0xff && at(b, 1) === 0xd8 && at(b, 2) === 0xff) return { mime: 'image/jpeg', ...jpegSize(b) };
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return { mime: 'image/gif', ...dims(le16(b, 6), le16(b, 8)) };
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { mime: 'image/webp', ...webpSize(b) };
  return null;
}

// ─── What an image costs in the context ───────────────────────────────────────
// Providers bill an image by its pixels, not its bytes: about width × height / 750
// tokens, after scaling it down to fit a long edge of 1568 and about 1.15 megapixels
// (what Anthropic documents; OpenAI's tiles land in the same range). An image whose
// size could not be read counts as the largest one would.
export const IMAGE_TOKENS_FALLBACK = 1600;
export function imageTokens(ref: { width?: number; height?: number }): number {
  const w = Number(ref.width), h = Number(ref.height);
  if (!(w > 0 && h > 0)) return IMAGE_TOKENS_FALLBACK;
  let scale = Math.min(1, 1568 / Math.max(w, h));
  const area = w * h * scale * scale;
  if (area > 1_150_000) scale *= Math.sqrt(1_150_000 / area);
  return Math.max(1, Math.ceil((w * scale) * (h * scale) / 750));
}

// ─── Tokens in the text ───────────────────────────────────────────────────────
export const imageToken = (n: number) => `[Image #${n}]`;
const TOKEN = /\[Image #(\d+)\]/g;

// Every token in `text` whose number `known` holds, as UTF-16 ranges [start, end).
export function imageTokenRanges(text: string, known: (n: number) => boolean): Array<{ n: number; start: number; end: number }> {
  const out: Array<{ n: number; start: number; end: number }> = [];
  for (const m of text.matchAll(TOKEN)) {
    const n = Number(m[1]);
    if (known(n)) out.push({ n, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// What a message sends: the images its tokens name, in the order they appear, each once.
export function imagesInText(text: string, byNumber: ReadonlyMap<number, ImageRef>): ImageRef[] {
  const seen = new Set<number>();
  const out: ImageRef[] = [];
  for (const r of imageTokenRanges(text, (n) => byNumber.has(n))) {
    if (seen.has(r.n)) continue;
    seen.add(r.n);
    out.push(byNumber.get(r.n)!);
  }
  return out;
}

// `text` cut into pieces at the token ranges — for drawing the tokens in a colour of
// their own. `from` is where `text` starts in the string the ranges were taken from.
export function splitTokens(text: string, from: number, ranges: ReadonlyArray<{ start: number; end: number }>): Array<{ text: string; token: boolean }> {
  const out: Array<{ text: string; token: boolean }> = [];
  let i = 0;
  for (const r of ranges) {
    const s = Math.max(0, r.start - from), e = Math.min(text.length, r.end - from);
    if (e <= 0 || s >= text.length) continue;
    if (s > i) out.push({ text: text.slice(i, s), token: false });
    out.push({ text: text.slice(Math.max(s, i), e), token: true });
    i = e;
  }
  if (i < text.length) out.push({ text: text.slice(i), token: false });
  return out;
}

// The field with a token put in at the caret, and a space after it unless one is there.
export function insertToken(value: string, cursor: number, n: number): { value: string; cursor: number } {
  const after = value.slice(cursor);
  const piece = `${imageToken(n)}${after.startsWith(' ') ? '' : ' '}`;
  return { value: value.slice(0, cursor) + piece + after, cursor: cursor + piece.length };
}

// Backspace right after a token, or Delete right before one, takes the whole token.
// null — the caret is not at a token's edge, and the key is the editor's.
export function removeTokenAt(value: string, cursor: number, dir: 'back' | 'forward', known: (n: number) => boolean): { value: string; cursor: number } | null {
  const hit = imageTokenRanges(value, known).find((r) => (dir === 'back' ? r.end === cursor : r.start === cursor));
  if (!hit) return null;
  return { value: value.slice(0, hit.start) + value.slice(hit.end), cursor: hit.start };
}

// ─── A pasted path ────────────────────────────────────────────────────────────
// A terminal pastes a file dragged onto it as its path: bare, quoted
// ('/My Screenshots/shot 1.png' from a Finder drop), or with a backslash before every
// space (`/My\ Screenshots/shot\ 1.png`), several files separated by spaces or lines;
// a few write a `file://` URL. The WHOLE paste must be paths for it to be read as
// paths — text that merely contains one stays text. null — it is not.
const PATHLIKE = /^(\/|~\/|~$|\.\.?\/)/;

function unfile(p: string): string {
  if (!p.startsWith('file://')) return p;
  try { return decodeURIComponent(new URL(p).pathname); } catch { return p; }
}

// Shell-like words: quotes group, a backslash escapes the next character, whitespace
// separates. null — an unclosed quote.
function words(text: string): string[] | null {
  const out: string[] = [];
  let cur = '', has = false, quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) cur += text[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (c === '\\' && i + 1 < text.length) { cur += text[++i]; has = true; }
    else if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ''; has = false; }
    else { cur += c; has = true; }
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out;
}

// Candidate readings of a paste, most literal first: the whole paste as ONE path
// (a name with spaces in it pasted bare) unless it is written with quotes or
// backslashes — then it is shell spelling — and then the paste split into words.
// `/image <path>` names a file on purpose, so there any word is a path (`shot.png`
// in the chat's directory); a paste must look like one.
export function pastedPaths(text: string, opts: { anyPath?: boolean } = {}): string[][] {
  const t = text.trim();
  if (!t) return [];
  const pathy = (p: string) => opts.anyPath || PATHLIKE.test(p);
  const out: string[][] = [];
  const one = unfile(t);
  if (!/[\n\\'"]/.test(t) && pathy(one)) out.push([one]);
  const w = words(t)?.map(unfile);
  // A quote left open is not shell spelling but part of the name (`Don't Panic.png`
  // pasted bare): then the whole paste is the one reading there is.
  if (!w && !t.includes('\n') && pathy(one)) out.push([one]);
  if (w?.length && w.every(pathy) && !(w.length === 1 && out[0]?.[0] === w[0])) out.push(w);
  return out;
}

// `~` → the home directory; a relative path is taken from `cwd`.
export function expandPath(p: string, cwd: string, home = os.homedir()): string {
  const e = p.replace(/^~(?=\/|$)/, home);
  return path.isAbsolute(e) ? e : path.resolve(cwd, e);
}

// ─── Reading an attachment ────────────────────────────────────────────────────
export const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
export const dataUrl = (mime: string, b: Uint8Array) => `data:${mime};base64,${Buffer.from(b).toString('base64')}`;

// "240 KB", "5.2 MB" — what the person reads.
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

export type LoadedOk = Extract<LoadedImage, { ok: true }>;
export type LoadedImage =
  | { ok: true; ref: Omit<ImageRef, 'n'>; data: Uint8Array }
  | { ok: false; reason: 'missing' | 'not-a-file' | 'not-an-image' | 'too-big'; error: string; name: string };

// Reads the file the person named: by its REAL path (a link is followed once, here,
// and the target is what is kept), no bigger than `maxBytes`, and only if its bytes
// say it is an image. The error says why not, in the person's words.
export function loadImageFile(spelled: string, cwd: string, maxBytes: number): LoadedImage {
  const full = expandPath(spelled, cwd);
  const name = path.basename(full);
  let real: string;
  let size: number;
  try {
    real = fs.realpathSync(full);
    const st = fs.statSync(real);
    if (!st.isFile()) return { ok: false, reason: 'not-a-file', error: `${name} is not a file`, name };
    size = st.size;
  } catch {
    return { ok: false, reason: 'missing', error: `no such file: ${spelled}`, name };
  }
  // A file over the limit is not read whole — its head is enough to say what it is.
  const head = Buffer.alloc(Math.min(size, 64 * 1024));
  try {
    const fd = fs.openSync(real, 'r');
    try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  } catch (e) {
    return { ok: false, reason: 'missing', error: `${name} cannot be read: ${(e as Error).message}`, name };
  }
  if (!sniffImage(head)) return { ok: false, reason: 'not-an-image', error: `${name} is not an image (png, jpeg, gif or webp)`, name };
  if (size > maxBytes) return { ok: false, reason: 'too-big', error: `${name} is ${fmtBytes(size)} — over the ${fmtBytes(maxBytes)} limit (ai.images.maxBytes); it is not shrunk to fit`, name };
  const data = fs.readFileSync(real);
  const kind = sniffImage(data)!;
  return { ok: true, ref: { name, path: real, sha256: sha256(data), mime: kind.mime, bytes: data.length, ...(kind.width ? { width: kind.width, height: kind.height } : {}) }, data };
}

// The bytes of a saved attachment, if the file at its path is still the one attached.
export function readImageData(ref: ImageRef): { ok: true; data: Uint8Array } | { ok: false; why: 'missing' | 'changed' } {
  let data: Uint8Array;
  try { data = fs.readFileSync(ref.path); } catch { return { ok: false, why: 'missing' }; }
  return sha256(data) === ref.sha256 ? { ok: true, data } : { ok: false, why: 'changed' };
}

// A ref read back from a session file — anything else in its place is dropped.
export function isImageRef(v: unknown): v is ImageRef {
  const r = v as Partial<ImageRef> | null;
  return !!r && Number.isInteger(r.n) && typeof r.name === 'string' && typeof r.path === 'string'
    && typeof r.sha256 === 'string' && typeof r.mime === 'string' && typeof r.bytes === 'number';
}

// ─── The wire ─────────────────────────────────────────────────────────────────
// OpenAI-compatible content parts: the text first, then each image as a `data:` URL.
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type ResolvedImage = { ok: true; url: string } | { ok: false; why: 'missing' | 'changed' | 'off' };

// The model's history with every image ref turned into what the provider takes. A
// message with images whose files all resolved goes as parts; one that could not be
// read is named in the text instead (`[image unavailable: name]`), so the rest of the
// message still goes. `images` never reaches the wire.
export function wireMessages(messages: ChatMessage[], resolve: (ref: ImageRef) => ResolvedImage): ChatMessage[] {
  return messages.map((m) => {
    const { images, ...rest } = m;
    if (!images?.length) return rest;
    let text = contentText(m.content);
    const parts: ContentPart[] = [];
    for (const ref of images) {
      const r = resolve(ref);
      if (r.ok) parts.push({ type: 'image_url', image_url: { url: r.url } });
      else text += `\n${r.why === 'off' ? `[image not sent: ${ref.name}]` : `[image unavailable: ${ref.name}]`}`;
    }
    return { ...rest, content: parts.length ? [{ type: 'text', text }, ...parts] : text };
  });
}

// A message's text, whatever its content is: parts are joined, an image named.
export function contentText(content: unknown): string {
  if (Array.isArray(content)) return (content as ContentPart[]).map((p) => (p?.type === 'text' ? p.text : '[image]')).join('\n');
  return String(content ?? '');
}

// Why nothing is attached while `ai.images.enabled` is false — the same words for a
// paste, a drop, `/image` and Ctrl+V.
export const IMAGES_OFF = 'images are off on this machine (ai.images.enabled is false) — config set ai.images.enabled true turns them on';

// Does a provider's refusal talk about the image? Then the model most likely cannot
// take one — `realChatRound` throws `LLM <status>: <body>`.
export const isImageRefusal = (message: string) => /^LLM 4\d\d\b/.test(message) && /image|content part|multimodal|vision/i.test(message);

// ─── The clipboard ────────────────────────────────────────────────────────────
// `/image` with no path, Ctrl+V, and an empty paste take the image on the clipboard:
// the platform's tool writes it to a private temporary file, which is then attached
// like any other. The runner is injected so tests stay offline, as `copy.ts` does.
export type ClipRun = (cmd: string, args: string[]) => { ok: boolean; missing?: boolean; stdout?: Uint8Array };
const clipRun: ClipRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  return { ok: !r.error && r.status === 0, missing, stdout: r.stdout ?? undefined };
};

export type ClipboardImage = { ok: true; path: string } | { ok: false; error: string; none?: boolean };

export function readClipboardImage(platform: string = process.platform, exec: ClipRun = clipRun, tmpDir?: string): ClipboardImage {
  const dir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'flow-assist-clip-'));
  const r = clipboardInto(dir, platform, exec);
  // A directory made for nothing is not left behind.
  if (!r.ok && !tmpDir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* not fatal */ } }
  return r;
}

function clipboardInto(dir: string, platform: string, exec: ClipRun): ClipboardImage {
  const file = path.join(dir, `clipboard-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  const wrote = () => { try { return fs.statSync(file).size > 0; } catch { return false; } };
  const save = (b: Uint8Array | undefined) => { if (!b?.length) return false; fs.writeFileSync(file, b, { mode: 0o600 }); return true; };
  if (platform === 'darwin') {
    // pngpaste where it is installed; otherwise AppleScript, which every Mac has:
    // asking for the clipboard as PNG fails when it holds no image.
    const pp = exec('pngpaste', [file]);
    if (pp.ok && wrote()) return { ok: true, path: file };
    if (!pp.missing) return { ok: false, none: true, error: 'no image on the clipboard' };
    const script = [
      'set png to (the clipboard as «class PNGf»)',
      `set f to open for access (POSIX file ${JSON.stringify(file)}) with write permission`,
      'set eof f to 0',
      'write png to f',
      'close access f',
    ];
    const osa = exec('osascript', script.flatMap((l) => ['-e', l]));
    if (osa.ok && wrote()) return { ok: true, path: file };
    if (osa.missing) return { ok: false, error: 'neither pngpaste nor osascript is available to read the clipboard' };
    return { ok: false, none: true, error: 'no image on the clipboard' };
  }
  if (platform === 'linux') {
    const tools: [string, string[]][] = [['wl-paste', ['--no-newline', '--type', 'image/png']], ['xclip', ['-selection', 'clipboard', '-target', 'image/png', '-out']]];
    let ran = false;
    for (const [cmd, args] of tools) {
      const r = exec(cmd, args);
      if (r.missing) continue;
      ran = true;
      if (r.ok && save(r.stdout)) return { ok: true, path: file };
    }
    if (!ran) return { ok: false, error: 'reading an image from the clipboard needs wl-paste (wl-clipboard) or xclip — neither is installed' };
    return { ok: false, none: true, error: 'no image on the clipboard' };
  }
  return { ok: false, error: `reading an image from the clipboard is not supported on ${platform} — /image <path> attaches a file` };
}
