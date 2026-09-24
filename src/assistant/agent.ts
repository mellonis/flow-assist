// Assistant agent loop (LLM client), with its own independently-configured model.
// It knows no plugin's domain: the chat's language is `config.ai.assistantLanguage`
// / `config.ai.language`, and a plugin that writes in a language of its own keeps
// that setting in its own config.
//
// One round is `chatRound` (POSTs `{baseUrl}/chat/completions`, streams content
// via onDelta, accumulates tool_calls fragments); `agentChat` is the loop
// "round → run tools → again" until a final text round; `compactConversation`
// is a one-shot non-streaming call for /compact. Tokens/baseUrl/model are read
// ONLY here, from opts (wired by the runtime from config through `llmOpts`,
// ./llm-endpoint.ts). `provider: 'anthropic'` swaps both calls for the native
// Messages API (./anthropic.ts) — `roundFor` and `compactConversation` are the only
// places that look at it.

// ─── Types ────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import type { ToolDef, ToolCtx } from '../loader/tools.js';
import { chatTools, execChatTool, chatToolDefs, chatToolGroupOf } from '../loader/tools.js';
import type { ToolRunEntry } from '../runtime/services/log.js';
import { changeView, type Change, type ChangeView } from './diff.js';
import { acceptData, isConsoleKind, readLegacyView, type ViewRecord } from './views.js';
import { capConsoleData } from './console-view.js';
import { contentText, type ContentPart, type ImageRef } from './images.js';
import { llmErrorMessage } from './llm-error.js';
import { ANTHROPIC_CONTENT, anthropicChatRound, anthropicCompact } from './anthropic.js';
import type { ThinkingConfig } from './llm-endpoint.js';
import {
  TOOLS_LOAD, createToolSet, deferredTools, notLoadedError, runToolsLoad, toolsToSend,
  type CatalogEntry, type ToolLoading, type ToolSet,
} from './tool-loading.js';

// A single chat message. `role` is the OpenAI role; `content` may be null when a
// message carries tool_calls. Extra fields (tool_calls, tool_call_id) ride along.
// `content` is content PARTS only on the way to the provider — a message the person
// sent with images (`wireMessages` in ./images.ts builds them). Everywhere the host
// keeps a message, its content is a string and its images ride beside it as saved
// refs (`images`), which never reach the wire.
export interface ChatMessage {
  role: string;
  content: string | ContentPart[] | null;
  images?: ImageRef[];
  [key: string]: unknown;
}

// One (possibly still-assembling) function call returned by a round.
export interface ToolCall {
  id?: string;
  name: string;
  arguments: string;
}

// What the provider says a request cost. `promptTokens` is the size of EVERYTHING sent
// — system prompt, tool definitions, the whole history — which is what "how full is the
// context" means.
export interface TokenUsage { promptTokens: number; completionTokens: number }

export interface ChatRoundResult {
  content: string;
  reasoning: string;
  finishReason: string;
  toolCalls: ToolCall[];
  // Present when the provider reported it (see `realChatRound`).
  usage?: TokenUsage;
  // The round's content blocks as the provider wrote them, when they must go back
  // unchanged within the turn (the Anthropic round's thinking, ./anthropic.ts). The
  // loop keeps them on the round's assistant message and nothing else reads them.
  blocks?: unknown[];
  // The provider refused the turn's kept thinking and the round went without any: the
  // loop drops the kept blocks and asks for no thinking for the rest of the turn.
  thinkingDropped?: boolean;
}

// A trace of one executed tool call — what actually ran, so the chat UI can show
// a persistent trail and distinguish a real write from a narrator's retelling.
export interface ToolRun {
  name: string;
  args: Record<string, unknown>;
  write?: boolean;
  outcome: string;
  detail: unknown;
  // What the write changed, as the tool reported it (`ctx.reportChange`) — drawn in
  // the chat, never sent to the model.
  changes?: ChangeView[];
  // The views the call left — in their final phase, never a discarded one; drawn in
  // the chat, never sent to the model.
  views?: ViewRecord[];
}

export interface AgentResult {
  content: string;
  process: string;
  toolRuns: ToolRun[];
  // Every message this turn ADDED to the conversation, in API shape: the
  // assistant messages carrying `tool_calls`, each tool result, and the final
  // assistant answer. The caller appends it to its API-side history so the next
  // turn replays what really happened (see `apiHistory`).
  transcript: ChatMessage[];
  // The loop ran out of rounds — `maxRounds` of them, every one carrying tool calls,
  // and no round that was an answer. The number is how many it took, so the chat can
  // say it where the answer would have been: a turn that ends with nothing said is
  // otherwise only visible as a wall of grey tool lines with no answer under it.
  roundLimit?: number;
  // What the provider reported for the LAST round, when it reports usage at all.
  usage?: TokenUsage;
}

// What a turn that THREW had done by then: `agentChat` hangs the transcript so far on
// the error it rethrows — the same error object, so its `name` (`'AbortError'` for Esc)
// still says what happened. A turn stopped or failed after a tool call ran still made
// that call (a write may have landed), and the model must be told; `apiHistory` drops
// the half of a pair a round left unfinished. Empty for an error that carries none.
export function transcriptSoFar(e: unknown): ChatMessage[] {
  const t = (e as { transcript?: unknown } | null)?.transcript;
  return Array.isArray(t) ? (t as ChatMessage[]) : [];
}

// Injectable tool-run logger (see the logToolRun reconciliation comment below).
export type ToolLogger = (entry: ToolRunEntry) => void;

export interface AgentOpts {
  onTool?: (name: string, args: string) => void;
  toolCtx?: ToolCtx;
  maxRounds?: number;
  onProcess?: (chunk: string) => void;
  extraTools?: ToolDef[];
  logTools?: boolean;
  logToolsPath?: string | null;
  logToolRun?: ToolLogger;
  baseUrl?: string;
  model?: string;
  token?: string;
  onLive?: (delta: string) => void;
  onLiveCommit?: (content: string, isFinal: boolean) => void;
  onReasoning?: (chunk: string) => void;
  confirmWrite?: (name: string, args: string) => boolean | Promise<boolean>;
  // Fired as each tool call ends (declined ones too), so the chat can show what a
  // write changed while the turn goes on.
  onToolRun?: (run: ToolRun) => void;
  chatRound?: (messages: ChatMessage[], opts: Record<string, unknown>) => Promise<ChatRoundResult>;
  // Diagnostic hook, fired once per round with what the model actually emitted in
  // THAT round — finish_reason + the count of tool_calls it streamed. Lets a caller
  // (the chat's log) distinguish "the model narrated a status change without
  // calling the tool" from "the model DID emit tool_calls but our loop dropped
  // them": a round with `finishReason === 'tool_calls'` must have toolCalls > 0; if
  // it is 0, the streaming accumulation failed (a real bug). Optional — background
  // tasks simply omit it.
  // `usage` is what the provider said THIS round cost, when it reports usage at all.
  // A turn is several rounds and is billed for each of them, so a caller that wants to
  // say what the turn costs adds these up; the LAST round's figure is a different
  // number — the size of the next request, which is what the context meter reads.
  onRound?: (info: { index: number; finishReason: string; toolCalls: number; contentLen: number; usage?: TokenUsage }) => void;
  // This round carries tool calls — fired the moment the first fragment of one
  // arrives, so a caller drawing the round's text as it streams learns what that text
  // is while it is still being written rather than after the round has ended.
  onRoundKind?: (kind: 'tools') => void;
  // Tools on demand (src/assistant/tool-loading.ts). 'all' — every tool in full on
  // every request, the default here, so a caller that does not say keeps what it had;
  // the chat, a background task and the one-shot CLI pass `ai.toolLoading`.
  // `toolSet` is the conversation's loaded set; without one a turn starts empty.
  toolLoading?: ToolLoading;
  toolSet?: ToolSet;
  // Every change to a view a call opened (`ctx.liveView`): its first state, each
  // update, and its final phase once the call ends. Display only — the chat draws it.
  onToolLive?: (rec: ViewRecord) => void;
  // The clock a view's start is read from; tests fix it.
  now?: () => number;
  // Any remaining OpenAI-ish options (tools, signal, …) — spread into the round.
  [key: string]: unknown;
}

// What `ctx.liveView(kind, data)` hands the tool back: `update` replaces the data
// (the chat redraws a few times a second, never faster than the round it runs in);
// `discard` removes the block once the call ends, as if it had never opened one. An
// update after the call has returned, or on a discarded view, is silently ignored —
// the tool's own clock does not stop at the same moment the call does.
export interface LiveView { update(data: unknown): void; discard(): void }

// ─── API-side history ─────────────────────────────────────────────────────────
// What a caller sends back on the next turn. The chat UI's own message list is a
// DISPLAY list — the turn's parts in order, the round being written, the answer —
// and must never be the model's history: replaying only the final text of each turn
// shows the model a transcript in which state changed with no tool call and no
// tool result, and it imitates exactly that (narrates the change, guesses at
// state). No system-prompt directive outweighs examples sitting in the history.
//
// So: keep only API fields, speak a background result to the model as the user,
// drop system messages (the caller prepends a fresh one), and never leave half of
// a call/result pair — providers reject an orphaned `tool` message and a
// `tool_calls` message with a missing result, and one bad pair poisons every
// later request.
export function apiHistory(messages: ChatMessage[]): ChatMessage[] {
  const clean: ChatMessage[] = [];
  for (const m of messages) {
    // 'note' is the host speaking to the person (/memory, what /clear kept) and 'view'
    // is a block a tool asked the host to draw (a command's output): display only,
    // both of them. The model already has the tool's own result — a second copy of it
    // in the conversation would cost the context twice.
    if (m.role === 'system' || m.role === 'note' || m.role === 'view') continue;
    // A background result and a `!command` the person ran reach the model as the user's.
    const out: ChatMessage = { role: m.role === 'bg' || m.role === 'shell' ? 'user' : m.role, content: m.content ?? null };
    // The images the person attached stay with their message for the rest of the
    // conversation — as refs; `send` turns them into parts on the way out.
    if (m.role === 'user' && Array.isArray(m.images) && m.images.length) out.images = m.images;
    // A call stored before this fix existed (or hand-edited) may carry arguments
    // that never parse — the same 400 a malformed call at the wire produces, forever,
    // since this is the history sent on every later request. Repaired here too, so an
    // old session recovers on its next request; never mutates `m` itself.
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = (m.tool_calls as Array<{ function?: { arguments?: unknown } }>).map((c) =>
        parsesAsJson(c?.function?.arguments) ? c : { ...c, function: { ...c.function, arguments: '{}' } },
      );
    }
    if (typeof m.tool_call_id === 'string') out.tool_call_id = m.tool_call_id;
    clean.push(out);
  }
  const answered = new Set(clean.filter((m) => m.role === 'tool').map((m) => m.tool_call_id as string));
  const asked = new Set<string>();
  const kept: ChatMessage[] = [];
  for (const m of clean) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const ids = (m.tool_calls as { id?: string }[]).map((c) => String(c.id));
      if (!ids.every((id) => answered.has(id))) continue; // a call whose result never arrived
      ids.forEach((id) => asked.add(id));
    } else if (m.role === 'tool' && !asked.has(String(m.tool_call_id))) {
      continue; // a result whose call is gone
    }
    kept.push(m);
  }
  return kept;
}

// ─── AI preconditions & headers ───────────────────────────────────────────────
function requireAiOpts({ baseUrl, model, token, tokenEnv }: { baseUrl?: string; model?: string; token?: string; tokenEnv?: string }): void {
  if (!token) throw new Error(`${tokenEnv || 'LLM_TOKEN'} is not set — add it to .env`);
  if (!baseUrl) throw new Error('config ai.baseUrl is not set');
  if (!model) throw new Error('config ai.model is not set');
}

const LLM_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

// ─── Assistant language (config ai.*) ─────────────────────────────────────────
// Two keys with a fallback chain: assistantLanguage → language → 'en' (a two-letter
// code). Prompts and tool descriptions stay English; the language only controls
// the ASSISTANT's reply language.
function langCode(v: unknown): string | undefined {
  return typeof v === 'string' && /^[a-z]{2}$/i.test(v.trim()) ? v.trim().toLowerCase() : undefined;
}

export function chatLanguage(ai: { assistantLanguage?: unknown; language?: unknown } | undefined | null): string {
  return langCode(ai?.assistantLanguage) ?? langCode(ai?.language) ?? 'en';
}

// Clips a long tool result so it does not bloat the context.
function clip(s: unknown, n = 6000): string {
  if (s == null) return '';
  const str = typeof s === 'string' ? s : JSON.stringify(s, null, 1);
  return str.length > n ? `${str.slice(0, n)}\n… (truncated)` : str;
}

// One round `POST {baseUrl}/chat/completions`. SSE chunks: `choices[0].delta.content`
// — incremental text (calls onDelta); `choices[0].delta.reasoning_content` — the
// model's "thinking" stream (calls onReasoning, not shown in the reply);
// `choices[0].delta.tool_calls[i]` — function fragments (id/name/arguments split
// across chunks, accumulated by index); `finish_reason: 'tool_calls'` returns the
// accumulated list.
// Base URLs that refused `stream_options` — not asked again in this process.
const noUsage = new Set<string>();

// A message as the OpenAI wire takes it: the Anthropic round's kept blocks are not an
// API field, and a strict server refuses a field it does not know.
function openAiShaped(m: ChatMessage): ChatMessage {
  if (!(ANTHROPIC_CONTENT in m)) return m;
  const { [ANTHROPIC_CONTENT]: _kept, ...rest } = m;
  return rest as ChatMessage;
}

// Which round the provider takes — the one place the chat loop asks. A caller's own
// `chatRound` (a test's stub) wins over both.
function roundFor(opts: Record<string, unknown>): NonNullable<AgentOpts['chatRound']> {
  if (typeof opts.chatRound === 'function') return opts.chatRound as NonNullable<AgentOpts['chatRound']>;
  if (opts.provider === 'anthropic') {
    return (messages, o) => {
      requireAiOpts(o as { baseUrl?: string; model?: string; token?: string; tokenEnv?: string });
      return anthropicChatRound(messages, o as Parameters<typeof anthropicChatRound>[1]);
    };
  }
  return realChatRound as NonNullable<AgentOpts['chatRound']>;
}

async function realChatRound(
  messages: ChatMessage[],
  {
    baseUrl,
    model,
    token,
    tools,
    onDelta = () => {},
    onReasoning = () => {},
    onToolCalls = () => {},
    signal,
    tokenEnv,
  }: {
    baseUrl?: string;
    model?: string;
    token?: string;
    tokenEnv?: string;
    tools?: ToolDef[];
    onDelta?: (d: string) => void;
    onReasoning?: (d: string) => void;
    onToolCalls?: () => void;
    signal?: AbortSignal;
  },
): Promise<ChatRoundResult> {
  requireAiOpts({ baseUrl, model, token, tokenEnv });
  // A streamed response carries token usage only when asked (`stream_options`). Most
  // OpenAI-compatible servers know the field; one that does not may answer 400 — so a
  // refusal that NAMES the field is retried once without it, and that base URL is not
  // asked again. Usage is a nicety; a chat that stops working over it is not.
  const post = (withUsage: boolean) => fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: LLM_HEADERS(token as string),
    body: JSON.stringify({ model, messages: messages.map(openAiShaped), stream: true, ...(withUsage ? { stream_options: { include_usage: true } } : {}), ...(tools?.length ? { tools } : {}) }),
  });
  const askUsage = !noUsage.has(String(baseUrl));
  let res = await post(askUsage);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (askUsage && res.status === 400 && /stream_options|include_usage/i.test(body)) {
      noUsage.add(String(baseUrl));
      res = await post(false);
      if (!res.ok) {
        const again = await res.text().catch(() => '');
        throw new Error(llmErrorMessage(res.status, again, { model, requestId: res.headers.get('x-request-id'), statusText: res.statusText }));
      }
    } else {
      throw new Error(llmErrorMessage(res.status, body, { model, requestId: res.headers.get('x-request-id'), statusText: res.statusText }));
    }
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('LLM: no response body');
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let finishReason = '';
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: TokenUsage | undefined;
  let done = false;
  while (!done) {
    const { value, done: readDone } = await reader.read();
    if (readDone) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        break;
      }
      let obj: { choices?: Array<{ finish_reason?: string; delta?: Record<string, unknown> }>; usage?: { prompt_tokens?: number; completion_tokens?: number } | null } | undefined;
      try {
        obj = JSON.parse(data);
      } catch {
        continue;
      }
      // Usage arrives in a chunk of its own, usually the last, with no choices.
      if (obj?.usage && typeof obj.usage.prompt_tokens === 'number') {
        usage = { promptTokens: obj.usage.prompt_tokens, completionTokens: Number(obj.usage.completion_tokens ?? 0) };
      }
      const ch = obj?.choices?.[0];
      if (ch?.finish_reason) finishReason = ch.finish_reason;
      const delta = ch?.delta as {
        reasoning_content?: string;
        content?: string;
        tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
      };
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        onReasoning(delta.reasoning_content);
      }
      if (delta?.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      // A round says it carries tool calls the moment its first fragment arrives —
      // long before the round ends, which is where the caller used to learn it. The
      // chat needs it that early: until it knows, the text streaming beside these
      // fragments is drawn as the answer, and a model that ignores the `Next:` shape
      // would otherwise have its paragraph reclassified after the person read it.
      if ((delta?.tool_calls ?? []).length && !toolCalls.size) onToolCalls();
      for (const tc of delta?.tool_calls ?? []) {
        const slot = toolCalls.get(tc.index) ?? { id: '', name: '', arguments: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        toolCalls.set(tc.index, slot);
      }
    }
  }
  return {
    content,
    reasoning,
    finishReason,
    toolCalls: [...toolCalls.values()].map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
    ...(usage ? { usage } : {}),
  };
}

// A call's arguments must parse to a JSON object to run. A stream that ends mid-
// argument (`{"path": "…", "ref": "f`) or a model that emits something that isn't an
// object at all (an array, a bare string, null) must not run silently as `{}` — the
// tool never asked for that, and `{}` hides the failure from the model instead of
// telling it what happened. Empty string keeps its old meaning, "no
// arguments": some providers send '' for a tool with no parameters.
function parseCallArgs(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === '' || raw == null) return { ok: true, args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed;
    return { ok: false, error: `expected a JSON object, got ${kind}` };
  }
  return { ok: true, args: parsed as Record<string, unknown> };
}

// Whether a stored `function.arguments` string is one apiHistory can leave as it is:
// a string that itself parses as JSON, of whatever shape (unlike parseCallArgs above,
// this does not require an object — apiHistory only has to keep the provider from
// answering "arguments must be valid JSON", not decide whether a tool could run).
function parsesAsJson(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  try {
    JSON.parse(v);
    return true;
  } catch {
    return false;
  }
}

// The model-facing tool result. The raw detail (success output, or an error message
// the catch block already prefixed "Error: ") is tagged with an unambiguous status so
// the model decides from a clear OK / ERROR / DECLINED, not by sniffing the prose —
// it can't read a failure as a success. The UI/log keep the raw `detail` + `outcome`
// separately, so this only shapes what the MODEL sees.
function modelToolResult(outcome: string, detail: unknown): string {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  if (outcome === 'declined') return `DECLINED: ${d}`;
  if (outcome === 'error') return `ERROR: ${d.replace(/^Error:\s*/i, '')}`;
  return `OK: ${d}`;
}

// ─── The tools a request may carry ────────────────────────────────────────────
// One entry per name, with the group it comes from. A plugin's aiTools reach
// `agentChat` TWICE: they are in the registry (the synthetic `<plugin>:aiTools` group)
// and the chat passes them again as `extraTools` for their `run`. The list for the
// provider used to concatenate both, and a provider answers a duplicate name with 400
// before the model runs — so with a real plugin enabled, every message failed. The
// extra wins, as in `agentChat`'s `toolByName`. `write`/`run` never go on the wire.
export function toolCatalog(extraTools: ToolDef[] = []): CatalogEntry[] {
  const sent = new Map<string, ToolDef>();
  for (const t of chatTools()) sent.set(t.function.name, t);
  for (const { write: _w, run: _r, ...rest } of extraTools) sent.set(rest.function.name, rest);
  const groupOf = chatToolGroupOf();
  return [...sent.values()].map((def) => ({ name: def.function.name, group: groupOf.get(def.function.name) ?? 'other', def }));
}

// What the NEXT request will carry — for the context meter, which must measure what
// is sent, not everything that could be.
export function requestTools(extraTools: ToolDef[], mode: ToolLoading = 'all', set: ToolSet = createToolSet()): ToolDef[] {
  return toolsToSend(toolCatalog(extraTools), mode, set);
}

// ─── Agent loop ───────────────────────────────────────────────────────────────
// Agentoid loop: content streams, tool_calls run through execChatTool, the result
// is pushed back as `role: tool`, and the loop runs until a final text round (or
// `maxRounds`, to guard against an infinite loop). `onTool(name, args)` reports the
// call to the host (for a status line). `toolCtx` is the runtime context the
// plugin/tool consumer hands through (the plan, the memory file, host services).
//
// Note on chat content: a "chatty" model's narration of its moves ("Let's try…")
// arrives in a round's `content` that ALSO carries tool_calls — before, that landed
// in the reply (full += r.content). Now it is folded into `process` (onProcess),
// and only the final no-tool_calls round is the answer (content → onDelta/onLive).
// Returns { content, process, toolRuns }.
export async function agentChat(
  messages: ChatMessage[],
  {
    onTool = () => {},
    toolCtx = {},
    maxRounds = 64,
    onProcess = () => {},
    extraTools = [],
    logTools = false,
    logToolsPath = null,
    logToolRun: logRun = () => {},
    toolLoading = 'all',
    toolSet = createToolSet(),
    ...opts
  }: AgentOpts = {},
): Promise<AgentResult> {
  // logToolRun reconciliation: the source called a free `logToolRun(file, entry)`
  // with a host-computed file path. The host exposes `createLogService(config)` whose
  // `.logToolRun(entry)` takes no file arg. The host agent therefore accepts an
  // INJECTABLE `logToolRun(entry)` (default no-op) wired by the runtime to the log
  // service; `logTools`/`logToolsPath` are kept for source compatibility but are
  // NOT used for the actual write (no toolsLogFile computed here).
  let current: ChatMessage[] = messages.slice();
  const turnStart = current.length;
  // Writing tools (write flag: true or a predicate (args) => boolean) ask for
  // confirmation via opts.confirmWrite (a y/n pause in chat) before running. In the
  // API we send tools WITHOUT the service fields write/run (a strict server may
  // reject them), but keep the full defs in toolByName for the confirmation check.
  // Plugin ai-tools (aiTools) sit on top of group tools: override by name and carry
  // their own `run(args, ctx)` instead of execChatTool.
  // `toolByName` is built from the UNSTRIPPED defs (`chatToolDefs()`) so a
  // `write`-flagged tool is present and `needsConfirm` fires — the stripped
  // `chatTools()` have no `write`, so confirmation would otherwise never trigger.
  const toolByName = new Map<string, ToolDef>();
  for (const t of chatToolDefs()) toolByName.set(t.function.name, t);
  for (const et of extraTools) toolByName.set(et.function.name, et);
  // Wire names. Providers validate a tool name against ^[a-zA-Z0-9_-]{1,128}$ and
  // answer 400 before the model runs, while the host qualifies plugin tools as
  // `plugin:tool`. The translation lives here and nowhere else: what is sent and
  // what the model calls use the wire name, everything inside the host — lookup,
  // confirmation, the trail the person sees — uses the real one.
  const realName = new Map<string, string>();
  const onWire = (t: ToolDef): ToolDef => {
    const wire = t.function.name.replace(/[^a-zA-Z0-9_-]/g, '__').slice(0, 128);
    realName.set(wire, t.function.name);
    return wire === t.function.name ? t : { ...t, function: { ...t.function, name: wire } };
  };
  const catalog = toolCatalog(extraTools);
  // Tools on demand: what is sent is worked out again for EVERY round — a `tools_load`
  // in one round puts the full definitions into the next. The wire names are mapped
  // for every known tool, not only the ones sent: the model may call a tool it saw
  // only in the index, and that call must still resolve to its real name to be told
  // it is not loaded.
  const deferred = deferredTools(catalog);
  const onDemand = toolLoading === 'onDemand' && deferred.size > 0;
  for (const e of catalog) onWire(e.def);
  const roundTools = (): ToolDef[] => toolsToSend(catalog, toolLoading, toolSet).map(onWire);
  let content = ''; // final answer (last round without tool_calls)
  let process = ''; // narration of moves from rounds WITH tool_calls — folded
  const toolRuns: ToolRun[] = []; // trace of executed tools
  const now = opts.now ?? Date.now;
  // Counts every call of the turn, declined ones included: another call between two
  // commands is what separates them — a view's `callId` says which call it belongs to.
  let seq = 0;
  // A view's `callId` used to be `${tc.id}#${n}` alone — a provider's own tool-call
  // id, which is NOT guaranteed unique across rounds of one turn (a test double
  // restarts at `call_0` every round; some real servers send '' or reuse ids). Two
  // commands whose ids collided overwrote one another's block. `turnKey` is random
  // per `agentChat` CALL (one per model turn), so `${turnKey}.${callSeq}#${n}` is
  // unique across the whole turn whatever the provider's ids do; `callSeq` alone
  // (this turn's own call counter, unique within it) would already be enough, but
  // keeping the provider's id absent from the key means it can never matter again.
  const turnKey = crypto.randomUUID();

  const chatRoundFn = roundFor(opts);

  // The LAST round's usage is the one that counts: its prompt is the whole turn so far.
  let usage: TokenUsage | undefined;
  // Did a round come back as an ANSWER? Without one the loop ran out of rounds, and
  // the caller has nothing to show for the turn but the trail.
  let answered = false;
  let rounds = 0;
  // Set once a round came back `thinkingDropped`: the rest of the turn asks for none.
  let noThinking = false;
  try {
    for (let i = 0; i < maxRounds; i++) {
      rounds = i + 1;
      let roundContent = '';
      const r = await chatRoundFn(current, {
        ...opts,
        tools: roundTools(),
        ...(noThinking ? { thinking: undefined } : {}),
        onToolCalls: () => opts.onRoundKind?.('tools'),
        // Round content streams LIVE via onLive while accumulating into roundContent.
        // Which shelf it belongs to (answer vs. narration fold) is decided at the end
        // of the round, when tool_calls arrive (or not).
        onDelta: (d: string) => {
          roundContent += d;
          (opts.onLive as AgentOpts['onLive'])?.(d);
        },
      } as Record<string, unknown>);
      if (r.usage) usage = r.usage;
      if (r.thinkingDropped) {
        noThinking = true;
        current = current.map((m) => {
          if (!(ANTHROPIC_CONTENT in m)) return m;
          const { [ANTHROPIC_CONTENT]: _kept, ...rest } = m;
          return rest as ChatMessage;
        });
      }
      // Diagnostic: what did THIS round actually emit? `finish_reason === 'tool_calls'`
      // promises tool_calls; if toolCalls is 0 the SSE accumulation silently dropped
      // them (a bug we'd want to catch). Distinguishes "the model narrated a status
      // change without calling the tool" from "the model DID call, we lost it".
      opts.onRound?.({
        index: i,
        finishReason: r.finishReason || (r.toolCalls.length ? 'tool_calls' : 'stop'),
        toolCalls: r.toolCalls.length,
        contentLen: r.content.length,
        ...(r.usage ? { usage: r.usage } : {}),
      });
      if (!r.toolCalls.length) {
        // Final round — the answer: already shown live via onLive, fix it as the
        // content. If the caller does not use onLiveCommit, fall back to chunked
        // onDelta (old behavior) so the agentic API stays compatible.
        content = roundContent;
        answered = true;
        current.push({ role: 'assistant', content: roundContent });
        if (opts.onLiveCommit) opts.onLiveCommit(roundContent, true);
        else if (typeof opts.onDelta === 'function') {
          for (const p of roundContent.match(/.{1,8}/gs) ?? []) {
            (opts.onDelta as (d: string) => void)(p);
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        break;
      }
      // Round with tool_calls: its content is the narration of moves. Already shown
      // live (onLive), now pin it in `process` (the folded plaque), not the answer.
      process += roundContent;
      if (opts.onLiveCommit) opts.onLiveCommit(roundContent, false);
      else if (roundContent) onProcess?.(roundContent);
      // Parsed once per call, up front: the assistant message pushed into history
      // needs to know NOW whether each call's arguments will run, because a call
      // that won't run still has to leave the history syntactically valid — the
      // history plays back `"{}"` in place of `tc.arguments` for anything that did
      // not itself arrive as JSON: a malformed call (parseCallArgs above), and an
      // empty string too, since `''` is what the model actually sent but is not
      // itself valid JSON — only `parseCallArgs`'s READING of it as "no arguments"
      // is.
      const callParses = r.toolCalls.map((tc) => parseCallArgs(tc.arguments));
      current.push({
        role: 'assistant',
        content: (r as ChatRoundResult).content || null,
        tool_calls: r.toolCalls.map((tc, idx) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: callParses[idx]!.ok && tc.arguments !== '' ? tc.arguments : '{}' },
        })),
        // The round's own blocks, thinking and signatures included, to go back as they
        // came in the next round of this turn (./anthropic.ts, `ANTHROPIC_CONTENT`).
        // Not once the turn has gone without thinking: none is sent back from then on.
        ...(r.blocks?.length && !noThinking ? { [ANTHROPIC_CONTENT]: r.blocks } : {}),
      });
      for (let idx = 0; idx < r.toolCalls.length; idx++) {
        const called = r.toolCalls[idx]!;
        const callParse = callParses[idx]!;
        // Another call between two commands is what separates them — counted here,
        // before the declined/refused branches, so either still takes its place.
        const callSeq = seq++;
        const tc = { ...called, name: realName.get(called.name) ?? called.name };
        onTool(tc.name, tc.arguments);
        const def = toolByName.get(tc.name);
        if (!callParse.ok) {
          // Arguments that don't parse to a JSON object: not run, no y/n — the tool
          // never asked for what arrived and opens no view. The model is told plainly
          // rather than handed a silent {} that hides the failure.
          const detail = `Error: the arguments were not valid JSON (${callParse.error.slice(0, 120)}) — nothing was run; call ${tc.name} again with a JSON object.`;
          current.push({ role: 'tool', tool_call_id: tc.id, content: modelToolResult('error', detail) });
          logRun({ name: tc.name, write: false, outcome: 'error', detail, args: {} });
          const run: ToolRun = { name: tc.name, args: {}, write: false, outcome: 'error', detail };
          toolRuns.push(run);
          opts.onToolRun?.(run);
          continue;
        }
        const parsed = callParse.args;
        // `write` is a flag/predicate on the tool def. A `true` write stays true; a
        // predicate write is evaluated against the actual parsed args (so a READ
        // action on a write-capable tool like `memory action:"list"` is NOT labeled
        // a write); a tool with no write is false.
        const write =
          def?.write === true
            ? true
            : typeof def?.write === 'function'
              ? !!def?.write?.(parsed)
              : false;
        // Known from the index, not loaded: refused before anything else — a write is
        // not put to the person for a call that will not run.
        const notLoaded = onDemand && deferred.has(tc.name) && !toolSet.has(tc.name);
        const confirm = opts.confirmWrite;
        const needsConfirm =
          !notLoaded &&
          typeof confirm === 'function' &&
          !!def?.write &&
          (def.write === true ? true : (def.write as (a: Record<string, unknown>) => boolean)(parsed));
        // outcome: applied — write really happened; declined — the user rejected it
        // (y/n); error — the tool threw (incl. Unknown tool if the name is not in the
        // registry); ok — a non-writing tool ran. detail — the result string to the model.
        let outcome = 'ok';
        let detail: unknown = '';
        if (needsConfirm && confirm) {
          const ok = await confirm(tc.name, tc.arguments);
          if (!ok) {
            outcome = 'declined';
            detail = 'This write operation was declined — the user must explicitly confirm before it runs.';
            current.push({ role: 'tool', tool_call_id: tc.id, content: modelToolResult('declined', detail) });
            logRun({ name: tc.name, write, outcome, detail, args: parsed });
            const run: ToolRun = { name: tc.name, args: parsed, write, outcome, detail };
            toolRuns.push(run);
            opts.onToolRun?.(run);
            continue;
          }
        }
        const changes: ChangeView[] = [];
        // The views this call opens: each a record the chat hears about on every change.
        // `ended` closes them — an update after the call returned is ignored.
        const opened: { rec: ViewRecord; discarded: boolean }[] = [];
        let ended = false;
        const emit = (rec: ViewRecord) => { try { opts.onToolLive?.(rec); } catch { /* the chat's trouble, not the tool's */ } };
        // A console view's data is capped where it is COLLECTED (as a confirmed
        // run_command's already was, src/assistant/console-view.ts), so a session file
        // stays bounded whichever path handed the data over — a live view's first
        // state, an update, or the legacy one-argument reportView below.
        const capIfConsole = (kind: string, data: unknown): unknown => (isConsoleKind(kind) ? capConsoleData(data) : data);
        const open = (kind: string, data: unknown): LiveView => {
          const capped = capIfConsole(kind, data);
          const slot = { rec: { kind: String(kind), data: acceptData(capped) ? capped : null, phase: 'live', startedAt: now(), callId: `${turnKey}.${callSeq}#${opened.length}`, seq: callSeq } as ViewRecord, discarded: false };
          opened.push(slot);
          emit(slot.rec);
          return {
            update: (next: unknown) => {
              if (ended || slot.discarded) return;
              const cappedNext = capIfConsole(slot.rec.kind, next);
              if (!acceptData(cappedNext)) return;
              slot.rec = { ...slot.rec, data: cappedNext };
              emit(slot.rec);
            },
            discard: () => { slot.discarded = true; },
          };
        };
        try {
          // The turn's signal rides in the ctx, so a tool that waits on something long
          // (run_command) stops with the answer when the person presses Esc.
          // `reportChange` collects what this call changed; a tool that throws after
          // reporting changed nothing the person should be shown as done.
          const callCtx: ToolCtx = {
            ...toolCtx,
            ...(opts.signal ? { signal: opts.signal } : {}),
            reportChange: (c: Change) => {
              try { const v = changeView(c); if (v) changes.push(v); } catch { /* a bad report never fails the write */ }
            },
            // A view the tool keeps open and updates while it runs.
            liveView: (kind: string, data: unknown) => open(kind, data),
            // A one-off view: opened and left; it becomes final with the call. The
            // one-argument form is how a console block was reported before renderers.
            reportView: (kind: unknown, data?: unknown) => {
              if (typeof kind === 'string') { open(kind, data); return; }
              const old = readLegacyView(kind);
              if (old) open('console', old.data);
            },
          };
          // Plugin ai-tool → its own `run(args, toolCtx)`; group tool → execChatTool
          // (lookup by name in the registry). `def.run` exists only on extraTools.
          // `tools_load` is the loop's own: it changes what the next round sends.
          if (notLoaded) throw new Error(notLoadedError(tc.name));
          detail = onDemand && tc.name === TOOLS_LOAD
            ? runToolsLoad(parsed, catalog, toolSet)
            : def?.run
              ? await (def.run as (args: Record<string, unknown>, ctx: ToolCtx) => unknown)(parsed, callCtx)
              : await execChatTool(tc.name, parsed, callCtx);
          outcome = write ? 'applied' : 'ok';
        } catch (e) {
          detail = `Error: ${e instanceof Error ? e.message : String(e)}`;
          outcome = 'error';
        }
        ended = true;
        const final = outcome === 'error' ? 'failed' : 'done';
        for (const s of opened) {
          s.rec = { ...s.rec, phase: s.discarded ? 'discarded' : final };
          emit(s.rec);
        }
        // A tool that threw keeps what it showed, marked failed: the person was reading it.
        const views = opened.filter((s) => !s.discarded).map((s) => s.rec);
        const detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
        current.push({ role: 'tool', tool_call_id: tc.id, content: modelToolResult(outcome, detailStr) });
        logRun({ name: tc.name, write, outcome, detail: detailStr, args: parsed });
        const run: ToolRun = { name: tc.name, args: parsed, write, outcome, detail: detailStr };
        if (outcome !== 'error' && changes.length) run.changes = changes;
        if (views.length) run.views = views;
        toolRuns.push(run);
        opts.onToolRun?.(run);
      }
    }
  } catch (e) {
    // Stopped (Esc) or failed mid-turn: what ran so far goes with the error, for the
    // caller's history (`transcriptSoFar`). A frozen error cannot carry it and is
    // rethrown as it is.
    if (e && typeof e === 'object' && Object.isExtensible(e)) Object.assign(e, { transcript: current.slice(turnStart) });
    throw e;
  }
  return {
    content, process, toolRuns, transcript: current.slice(turnStart),
    ...(answered ? {} : { roundLimit: rounds }),
    ...(usage ? { usage } : {}),
  };
}

// What /compact sends of a message: its text, an image named in it and not sent — the
// summary is text, and the images end with the history it replaces.
function compactable(m: ChatMessage): ChatMessage {
  const { images, ...rest } = m;
  const named = (images ?? []).map((r) => `[image: ${r.name}]`).join(' ');
  const text = contentText(m.content);
  return { ...rest, content: named ? `${text}${text ? ' ' : ''}${named}` : Array.isArray(m.content) ? text : m.content };
}

// One-shot non-streaming call for /compact: compresses the history into a compact
// system context (key facts, decisions, open questions). No tools.
export async function compactConversation(
  messages: ChatMessage[],
  { baseUrl, model, token, tokenEnv, provider, maxTokens, thinking, signal }: { baseUrl?: string; model?: string; token?: string; tokenEnv?: string; provider?: string; maxTokens?: number; thinking?: ThinkingConfig; signal?: AbortSignal },
): Promise<string> {
  requireAiOpts({ baseUrl, model, token, tokenEnv });
  const instruction: ChatMessage = {
    role: 'system',
    content:
      'Compress the chat history below into a compact system context (up to ~400 words). Keep the key facts, decisions made and open questions. Return only the compressed text.',
  };
  const history = messages.filter((m) => m.role !== 'system').slice(-30).map(compactable);
  if (provider === 'anthropic') return anthropicCompact([instruction, ...history], { baseUrl, model, token, maxTokens, thinking, signal });
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: LLM_HEADERS(token as string),
    body: JSON.stringify({
      model,
      messages: [instruction, ...history],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(llmErrorMessage(res.status, body, { model, requestId: res.headers.get('x-request-id'), statusText: res.statusText }));
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data?.choices?.[0]?.message?.content ?? '';
}