// An earlier tool call's result, by its id — what `run_command`'s `stdinFrom` pipes into
// a command, so the model can process data it already has without writing it out again
// as an argument (re-typed, a U+00A0 comes back as a plain space, and a long result
// costs its length twice).
//
// The result is the text the TOOL returned as its data — never the `OK:` tag the model
// reads it under, never `capToolResult`'s cut (./tool-result-cap.ts), never a frame the
// tool put around it for the model: a tool that frames its text returns `{ text, raw }`
// (`toolReturn`), `raw` the bare data, `null` when there is none to pipe (a failed call
// the tool answers in words). Where the host keeps it: the `role: 'tool'` message itself,
// in the model's history (`apiRef`, and so the session). Its content is the tagged
// result; when that is not the data plus the tag — cut, framed — the data rides beside
// it as `RAW_RESULT`, which no request carries (`apiHistory` for a later turn,
// `withAttachedImages` within one). Data past `RAW_MAX` is not kept at all, only its
// length (`RAW_OMITTED`). A result the tool neither framed nor the cap cut is its
// content without the tag, so nothing is kept twice.
//
// Pure: the caller hands in the history to search (the chat's `apiRef` and the turn so
// far — never the stubbed copy a request is built from), the recall items for the
// `res:` alias, and how a wire name reads as the host's.
import type { ChatMessage } from './agent.js';
import { contentText } from './images.js';
import { findItem, hashOf, type BulkyItem } from './recall.js';
import { wasCut } from './tool-result-cap.js';

// The field on a tool message that holds the data when its content is not the data
// plus the tag; `null` — the tool said there is none.
export const RAW_RESULT = 'raw';
// The field that stands in for data over `RAW_MAX`: its length.
export const RAW_OMITTED = 'rawOmitted';
// The most data kept for piping, in characters (1 MiB) — it rides in the session.
export const RAW_MAX = 1024 * 1024;

// What a tool's return value says: the result the model reads (`detail`, handed on to
// the image path when it carries images) and the data behind it (`whole`) — a string,
// `null` for none, or `undefined` when the return says nothing and the result is the
// data. A return is read as `{ text, raw }` only when `text` is a string and it has a
// `raw` key; any other value is left as it is.
export function toolReturn(v: unknown): { detail: unknown; whole: string | null | undefined } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { detail: v, whole: undefined };
  const r = v as { text?: unknown; raw?: unknown; images?: unknown };
  const images = Array.isArray(r.images);
  if (typeof r.text !== 'string' || !('raw' in r)) return { detail: v, whole: images && typeof r.text === 'string' ? r.text : undefined };
  const whole = typeof r.raw === 'string' ? r.raw : null;
  if (images) { const { raw: _raw, ...rest } = r; return { detail: rest, whole }; }
  return { detail: r.text, whole };
}

// The fields a tool message carries beside its content (`sent`, the tagged and maybe cut
// result) for the data `whole`: none when the content is the data plus the tag.
export function keptRaw(sent: string, whole: string | null): Record<string, unknown> {
  if (whole === null) return { [RAW_RESULT]: null };
  if (sent === `OK: ${whole}`) return {};
  return whole.length > RAW_MAX ? { [RAW_OMITTED]: whole.length } : { [RAW_RESULT]: whole };
}

export type FoundResult = { ok: true; id: string; tool: string; text: string } | { ok: false; error: string };

// The result of the call `ref` names: a tool call id of this conversation, or — where
// the result goes to the model as a stub — the recall item id the stub names (`res:…`,
// any unique prefix), which reads the result whose content is the item's. A reused id
// (a provider's ids are not unique across rounds) reads the latest result. Refused,
// naming the id: nothing by that id, a call that failed or was declined, a result with
// no data to pipe, one that is images and no text, one too large to have been kept, one
// cut before it was kept.
export function findToolResult(
  history: ChatMessage[],
  ref: unknown,
  { items = [], nameOf = (n: string) => n }: { items?: BulkyItem[]; nameOf?: (wire: string) => string } = {},
): FoundResult {
  const asked = typeof ref === 'string' ? ref.trim() : '';
  if (!asked) return { ok: false, error: 'empty — give the id of an earlier tool call' };
  let id = asked;
  let at = history.findLastIndex((m) => m.role === 'tool' && m.tool_call_id === id);
  if (at < 0) {
    const alias = findItem(items.filter((i) => i.kind === 'res' && i.callId), asked);
    if (alias.ok) {
      id = alias.item.callId!;
      const hash = alias.item.hash;
      at = history.findLastIndex((m) => m.role === 'tool' && m.tool_call_id === id && typeof m.content === 'string' && hashOf(m.content) === hash);
    }
  }
  if (at < 0) return { ok: false, error: `no tool call "${asked}" in this conversation — give the id of an earlier call that returned text` };
  const m = history[at]!;
  // The call's name, from the assistant message that made it — the nearest before.
  let wire = 'tool';
  for (let i = at - 1; i >= 0; i--) {
    const c = (history[i]!.tool_calls as Array<{ id?: unknown; function?: { name?: unknown } }> | undefined)?.find((x) => x?.id === id);
    if (c) { wire = String(c.function?.name ?? 'tool'); break; }
  }
  const tool = nameOf(wire);
  const content = contentText(m.content);
  if (/^ERROR:/.test(content)) return { ok: false, error: `the call "${asked}" (${tool}) failed — it has no result to pipe` };
  if (/^DECLINED:/.test(content)) return { ok: false, error: `the call "${asked}" (${tool}) was declined — it has no result to pipe` };
  const omitted = m[RAW_OMITTED];
  if (typeof omitted === 'number') return { ok: false, error: `the result of "${asked}" (${tool}) is too large to pipe: ${omitted} characters, over the ${RAW_MAX} kept — ask ${tool} for less` };
  const raw = m[RAW_RESULT];
  if (raw === null) return { ok: false, error: `the call "${asked}" (${tool}) returned no data to pipe — its answer says why` };
  if (typeof raw !== 'string') {
    if (!/^OK: /.test(content)) return { ok: false, error: `the result of "${asked}" (${tool}) is not one the host kept whole` };
    if (wasCut(content)) return { ok: false, error: `the result of "${asked}" (${tool}) was kept cut, not whole — call ${tool} again and pipe that call` };
  }
  const text = typeof raw === 'string' ? raw : content.replace(/^OK: /, '');
  if (!text && Array.isArray(m.images) && m.images.length) return { ok: false, error: `the result of "${asked}" (${tool}) is images, not text` };
  return { ok: true, id, tool, text };
}
