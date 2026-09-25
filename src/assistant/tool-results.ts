// An earlier tool call's result, by its id — what `run_command`'s `stdinFrom` pipes into
// a command, so the model can process data it already has without writing it out again
// as an argument (re-typed, a U+00A0 comes back as a plain space, and a long result
// costs its length twice).
//
// The result is the text the TOOL returned — never the `OK:` tag the model reads it
// under, never `capToolResult`'s cut (./tool-result-cap.ts). Where the host keeps it:
// the `role: 'tool'` message itself, in the model's history (`apiRef`, and so the
// session). Its content is the tagged result; when the cap cut that, the whole text
// rides beside it as `RAW_RESULT`, which `apiHistory` never sends. A result the cap left
// alone is its content without the tag, so nothing is kept twice.
//
// Pure: the caller hands in the history to search (the chat's `apiRef` and the turn so
// far — never the stubbed copy a request is built from), the recall items for the
// `res:` alias, and how a wire name reads as the host's.
import type { ChatMessage } from './agent.js';
import { contentText } from './images.js';
import { findItem, type BulkyItem } from './recall.js';
import { wasCut } from './tool-result-cap.js';

// The field on a tool message that holds the whole result when its content was cut.
export const RAW_RESULT = 'raw';

export type FoundResult = { ok: true; id: string; tool: string; text: string } | { ok: false; error: string };

// The result of the call `ref` names: a tool call id of this conversation, or — where
// the result goes to the model as a stub — the recall item id the stub names (`res:…`,
// any unique prefix). A reused id (a provider's ids are not unique across rounds) reads
// the latest result. Refused, naming the id: nothing by that id, a call that failed or
// was declined, a result that is images and no text, a result cut before it was kept.
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
      at = history.findLastIndex((m) => m.role === 'tool' && m.tool_call_id === id);
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
  const raw = m[RAW_RESULT];
  if (typeof raw !== 'string' && wasCut(content)) return { ok: false, error: `the result of "${asked}" (${tool}) was kept cut, not whole — call ${tool} again and pipe that call` };
  const text = typeof raw === 'string' ? raw : content.replace(/^OK: /, '');
  if (!text && Array.isArray(m.images) && m.images.length) return { ok: false, error: `the result of "${asked}" (${tool}) is images, not text` };
  return { ok: true, id, tool, text };
}
