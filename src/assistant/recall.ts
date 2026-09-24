// Bulky content is sent in full once, then as a stub the model can recall.
//
// An attached screenshot, a `!command`'s 120 lines, a whole file a tool read back:
// each is useful in the turn that works with it and mostly dead weight afterwards — yet
// it stays in the model's history and rides every later request. So a BULKY ITEM (an
// image, a `!`/`!!` output, a tool result over `ai.recall.minChars`) is sent in full in
// the turn it arrives in, all its rounds, and from a later batch on as a short stub
// naming an id: `[$ brew update — exit 0 · 24.7 s · 120 lines — recall("out:7d41e0aa")]`.
// The `recall` core tool brings the item back for one turn — an image as an image.
//
// An id is a CONTENT HASH, `<kind>:<first 8 hex of sha256>` — `img:` an image (the
// sha256 its ref already carries), `out:` a `!command`'s message, `res:` a tool result.
// So it survives /compact, /resume and deletions, identical content shares one id and
// one stored item, and `recall` takes any unique prefix.
//
// What the host KEEPS never changes shape: `apiRef` and the session hold the full
// content; a stub is applied on the way OUT (`applyRecall`, where the chat builds what
// it sends). Which items are stubbed is conversation state (`RecallState`, owned by the
// chat like the plan, saved with the session, reset by /clear), decided in BATCHES
// (`decideBatch`): replacing old content changes the request's prefix and costs one
// prompt-cache miss, so it happens when the context passes `ai.recall.threshold` or
// every `ai.recall.everyTurns` turns, every eligible item at once — and a stub is a
// pure function of its item, so the prefix stays byte-stable between batches.
//
// Pure: no I/O. An image's bytes come through the `resolveImage` a caller hands in.
import crypto from 'node:crypto';
import type { ChatMessage } from './agent.js';
import { contentText, type ImageRef, type ResolvedImage } from './images.js';

// ─── Config ───────────────────────────────────────────────────────────────────
// `ai.recall`: on by default. `threshold` is the share of `ai.contextWindow` past which
// the next turn's end stubs every eligible item; `everyTurns` batches on a clock as well
// (0 — the threshold alone); `minChars` is what makes a tool result bulky — an image
// and a `!command`'s output always are.
export const RECALL_DEFAULTS = { enabled: true, threshold: 0.5, minChars: 4096, everyTurns: 10 };
export interface RecallLimits { enabled: boolean; threshold: number; minChars: number; everyTurns: number }
export function recallLimits(ai: unknown): RecallLimits {
  const c = ((ai as { recall?: unknown } | undefined)?.recall ?? {}) as Record<string, unknown>;
  const posInt = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : d);
  const count = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : d);
  const ratio = (v: unknown, d: number) => (typeof v === 'number' && v > 0 && v <= 1 ? v : d);
  return {
    enabled: c.enabled !== false,
    threshold: ratio(c.threshold, RECALL_DEFAULTS.threshold),
    minChars: posInt(c.minChars, RECALL_DEFAULTS.minChars),
    everyTurns: count(c.everyTurns, RECALL_DEFAULTS.everyTurns),
  };
}

// ─── Items and their ids ──────────────────────────────────────────────────────
export type BulkyKind = 'img' | 'out' | 'res';
export interface BulkyItem {
  id: string; // `<kind>:<8 hex>`
  hash: string; // the whole sha256 the id is cut from — what a message is matched by
  kind: BulkyKind;
  stub: string; // what is sent in the item's place — a pure function of the item
  chars: number;
  lines: number;
  content?: string; // `out` / `res`: the text `recall` returns
  ref?: ImageRef; // `img`: what `recall` sends again as an image
}

// What a `!command`'s message carries beside its text (`ShellMeta` on the `shell`
// message in the model's history), so its stub can name the command and how it ended.
export interface ShellMeta { command: string; outcome: string; ms: number; lines: number }

export const hashOf = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
export const itemId = (kind: BulkyKind, hash: string): string => `${kind}:${hash.slice(0, 8)}`;
const RECALL_CALL = (id: string) => `recall("${id}")`;
const countLines = (text: string): number => (text ? text.split('\n').length : 0);
const fmtSecs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// The head a recall's own result starts with (`recallResult`), read back by the stub
// of that result so it points at the item recalled rather than offering a second id.
const RECALLED_HEAD = /^(?:OK: )?\[recalled ((?:img|out|res):[0-9a-f]{8}) — /;

export function imageStub(ref: ImageRef): string {
  const size = ref.width && ref.height ? ` · ${ref.width}×${ref.height}` : '';
  return `[image ${ref.name}${size} — ${RECALL_CALL(itemId('img', ref.sha256))}]`;
}

// Without the meta (a session saved before it was kept) the command is read off the
// text's own `$ ` line, and the count is the message's.
function shellStub(id: string, meta: ShellMeta | null, content: string): string {
  if (meta) return `[$ ${meta.command} — ${meta.outcome} · ${fmtSecs(meta.ms)} · ${meta.lines} lines — ${RECALL_CALL(id)}]`;
  const cmd = /^\$ (.+)$/m.exec(content)?.[1] ?? '…';
  return `[$ ${cmd} — ${countLines(content)} lines — ${RECALL_CALL(id)}]`;
}

// The first string argument of the call, on one line and short — what names a
// `read_file` in its stub. Deterministic: the same call, the same words.
function firstArg(args: unknown): string {
  if (typeof args !== 'string' || !args) return '';
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const v = Object.values(parsed ?? {}).find((x) => typeof x === 'string' && (x as string).trim());
    const s = String(v ?? '').replace(/\s+/g, ' ').trim();
    return s.length > 60 ? `${s.slice(0, 59)}…` : s;
  } catch {
    return '';
  }
}

function resultStub(id: string, content: string, call: { name: string; args: unknown } | null): string {
  const lines = countLines(content);
  const recalled = RECALLED_HEAD.exec(content)?.[1];
  if (recalled) return `[recalled ${recalled} — ${lines} lines — ${RECALL_CALL(recalled)}]`;
  const what = call ? `${call.name}${firstArg(call.args) ? ` ${firstArg(call.args)}` : ''}` : 'tool result';
  return `[${what} — ${lines} lines — ${RECALL_CALL(id)}]`;
}

function shellMetaOf(v: unknown): ShellMeta | null {
  const m = v as Partial<ShellMeta> | null;
  if (!m || typeof m !== 'object' || typeof m.command !== 'string') return null;
  return { command: m.command, outcome: typeof m.outcome === 'string' ? m.outcome : '?', ms: Number(m.ms) || 0, lines: Number.isInteger(m.lines) ? (m.lines as number) : 0 };
}

// Every bulky item the model's history (`apiRef`, the host's own shape — a `!command`
// is still role `shell` there) holds, in order of first appearance, each id once. A
// tool result is bulky over `minChars`; an image and a `!command`'s output always are.
export function bulkyItems(api: ChatMessage[], minChars: number): BulkyItem[] {
  const out = new Map<string, BulkyItem>();
  const add = (item: BulkyItem) => { if (!out.has(item.id)) out.set(item.id, item); };
  // A result's call, by id — the assistant message just before names the tool.
  const calls = new Map<string, { name: string; args: unknown }>();
  for (const m of api) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
        if (c?.id != null) calls.set(String(c.id), { name: String(c.function?.name ?? 'tool'), args: c.function?.arguments });
      }
    }
    if (m.role === 'user' && Array.isArray(m.images)) {
      for (const ref of m.images as ImageRef[]) {
        if (!ref || typeof ref.sha256 !== 'string') continue;
        add({ id: itemId('img', ref.sha256), hash: ref.sha256, kind: 'img', stub: imageStub(ref), chars: 0, lines: 0, ref });
      }
      continue;
    }
    if (m.role === 'shell' && typeof m.content === 'string' && m.content) {
      const hash = hashOf(m.content);
      const id = itemId('out', hash);
      add({ id, hash, kind: 'out', stub: shellStub(id, shellMetaOf(m.shell), m.content), chars: m.content.length, lines: countLines(m.content), content: m.content });
      continue;
    }
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length >= minChars) {
      const hash = hashOf(m.content);
      const id = itemId('res', hash);
      add({ id, hash, kind: 'res', stub: resultStub(id, m.content, calls.get(String(m.tool_call_id)) ?? null), chars: m.content.length, lines: countLines(m.content), content: m.content });
    }
  }
  return [...out.values()];
}

// ─── The batch decision — conversation state ──────────────────────────────────
export interface RecallState {
  stubbed: Set<string>; // the ids sent as stubs from now on
  recalled: Set<string>; // the ids `recall` brought back in the current turn — the /context line
  turns: number; // turns since the last batch
}

export function createRecallState(saved?: { stubbed?: unknown; turns?: unknown } | null): RecallState {
  const ids = Array.isArray(saved?.stubbed) ? saved!.stubbed.filter((v): v is string => typeof v === 'string') : [];
  const turns = Number.isInteger(saved?.turns) && (saved!.turns as number) >= 0 ? (saved!.turns as number) : 0;
  return { stubbed: new Set(ids), recalled: new Set(), turns };
}
export function saveRecallState(s: RecallState): { stubbed: string[]; turns: number } {
  return { stubbed: [...s.stubbed], turns: s.turns };
}

// At the end of a turn: the stubbed set grows by every eligible item at once when the
// context is past the threshold or the turn clock is due — and not otherwise, so the
// request's prefix changes at a batch and never between two. Returns whether it did
// change (then the caller saves). A batch that is due finds nothing new leaves the set,
// and so the prefix, as it was.
export function decideBatch(state: RecallState, items: BulkyItem[], ratio: number, limits: RecallLimits): boolean {
  if (!limits.enabled) return false;
  state.turns += 1;
  const due = ratio >= limits.threshold || (limits.everyTurns > 0 && state.turns >= limits.everyTurns);
  if (!due) return false;
  state.turns = 0;
  let changed = false;
  for (const item of items) {
    if (state.stubbed.has(item.id)) continue;
    state.stubbed.add(item.id);
    changed = true;
  }
  return changed;
}

// ─── Applying the stubs on the way out ────────────────────────────────────────
// `messages` is what `apiHistory` gave — a `!command` is a user message there, a tool
// result a tool message — and comes back with every stubbed item replaced: an image
// taken off its message and named in its text, an output or a result replaced by its
// stub. Matched by content: the hash is the id, so a message is looked up only when
// its length is one of the stubbed items' (a hash for every message on every render
// would be waste). Messages not touched are the same objects.
export function applyRecall(messages: ChatMessage[], items: BulkyItem[], stubbed: ReadonlySet<string>): ChatMessage[] {
  if (!stubbed.size) return messages;
  const byImage = new Map<string, BulkyItem>();
  const byHash = new Map<string, BulkyItem>();
  const lengths = new Set<number>();
  for (const item of items) {
    if (!stubbed.has(item.id)) continue;
    if (item.kind === 'img') byImage.set(item.hash, item);
    else { byHash.set(item.hash, item); lengths.add(item.chars); }
  }
  if (!byImage.size && !byHash.size) return messages;
  return messages.map((m) => {
    if (m.role === 'user' && Array.isArray(m.images) && m.images.length && byImage.size) {
      const kept: ImageRef[] = [];
      const stubs: string[] = [];
      for (const ref of m.images) {
        const item = byImage.get(ref.sha256);
        if (item) stubs.push(item.stub); else kept.push(ref);
      }
      if (!stubs.length) return m;
      const { images: _images, ...rest } = m;
      const text = contentText(m.content);
      return { ...rest, content: `${text}${text ? '\n' : ''}${stubs.join('\n')}`, ...(kept.length ? { images: kept } : {}) };
    }
    if ((m.role === 'tool' || m.role === 'user') && typeof m.content === 'string' && lengths.has(m.content.length)) {
      const item = byHash.get(hashOf(m.content));
      if (item) return { ...m, content: item.stub };
    }
    return m;
  });
}

// ─── The `recall` tool's half ─────────────────────────────────────────────────
// What the chat hands the tool as `ctx.recall`: the conversation's items, how to read
// an attached image's bytes again, and where to count a recall for the /context line.
export interface RecallSource {
  items(): BulkyItem[];
  resolveImage?: (ref: ImageRef) => ResolvedImage;
  onRecalled?: (id: string) => void;
}

export type Found = { ok: true; item: BulkyItem } | { ok: false; error: string };

// The id as the model wrote it: whole, any unique prefix, or the hash alone (the kind
// before the colon is what a person reads; the model may drop it). Ambiguous — the
// candidates, each with its stub, so the next call can be exact.
export function findItem(items: BulkyItem[], query: string): Found {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, error: 'id is required — the id a stub names, e.g. recall("out:7d41e0aa"); a unique prefix is enough' };
  const exact = items.find((i) => i.id === q);
  if (exact) return { ok: true, item: exact };
  const hits = items.filter((i) => i.id.startsWith(q) || i.id.slice(i.id.indexOf(':') + 1).startsWith(q));
  if (hits.length === 1) return { ok: true, item: hits[0]! };
  if (hits.length > 1) return { ok: false, error: `"${q}" matches more than one item: ${hits.map((i) => `${i.id} ${i.stub.replace(/ — recall\("[^"]*"\)\]$/, ']')}`).join('; ')} — give more of the id` };
  return { ok: false, error: `nothing in the conversation matches "${q}" — an item that was stubbed names its id in its stub, e.g. recall("out:7d41e0aa"); after /compact the items it summarised are gone` };
}

export type Recalled = { ok: true; text: string; image?: { ref: ImageRef; url: string } } | { ok: false; error: string };

// What the tool answers with: text whole under a header naming the item, or — for an
// image — a sentence and the image itself, resolved by the caller (the chat reads the
// file again and checks its hash) to go beside the result as an image part.
export function recallResult(item: BulkyItem, deps: { resolveImage?: (ref: ImageRef) => ResolvedImage }): Recalled {
  if (item.kind !== 'img') return { ok: true, text: `[recalled ${item.id} — ${item.lines} lines]\n${item.content ?? ''}` };
  const ref = item.ref!;
  if (!deps.resolveImage) return { ok: false, error: 'no image can be sent from here' };
  const r = deps.resolveImage(ref);
  if (!r.ok) {
    const why = r.why === 'missing' ? `is no longer at ${ref.path}` : r.why === 'changed' ? 'has changed on disk since it was attached' : '';
    return { ok: false, error: r.why === 'off' ? 'images are off on this machine (ai.images.enabled is false)' : `the image ${ref.name} ${why}` };
  }
  const size = ref.width && ref.height ? ` · ${ref.width}×${ref.height}` : '';
  return { ok: true, text: `[recalled ${item.id} — ${ref.name}${size} — sent as an image beside this result, for this turn]`, image: { ref, url: r.url } };
}

// ─── The /context line ────────────────────────────────────────────────────────
export function recallLine(stubbed: number, recalled: number): string {
  if (!stubbed && !recalled) return '';
  const s = stubbed ? `${stubbed} item${stubbed === 1 ? '' : 's'} stubbed` : 'nothing stubbed';
  const r = recalled ? `${recalled} recalled this turn` : 'none recalled this turn';
  return `recall: ${s} · ${r}`;
}
