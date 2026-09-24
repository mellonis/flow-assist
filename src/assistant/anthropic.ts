// Anthropic's own Messages API, behind the same seam as the OpenAI-compatible round
// (`ai.provider: 'anthropic'`; the switch is `roundFor` / `compactConversation` in
// ./agent.ts). What the host KEEPS does not change: the history stays OpenAI-shaped —
// system / user / assistant with `tool_calls` / tool — so a session reads the same
// whichever provider wrote it. It is converted here, on the way out, every request.
//
// What the native API gives that the compatibility endpoint loses:
//   - prompt caching: a `cache_control` breakpoint on the last system block and on the
//     last tool definition, the parts every round repeats;
//   - thinking: `thinking_delta` goes where the OpenAI path's reasoning goes (the chat's
//     `thinking` fold), and the round's thinking blocks go back UNCHANGED, signatures
//     and all, in the next request of the same turn — the API requires them while a
//     tool loop runs (see `anthropicContent` below);
//   - exact usage, the cache's share included.
//
// Pure except `anthropicChatRound` / `anthropicCompact`, which fetch.

import type { ToolDef } from '../loader/tools.js';
import type { ChatMessage, ChatRoundResult, TokenUsage } from './agent.js';
import type { ContentPart } from './images.js';
import { llmErrorMessage } from './llm-error.js';
import type { ThinkingConfig } from './llm-endpoint.js';

export const ANTHROPIC_VERSION = '2023-06-01';

// The smallest fixed thinking budget the API takes.
export const MIN_THINKING_BUDGET = 1024;

type Block = Record<string, unknown> & { type: string };
export interface AnthropicMessage { role: 'user' | 'assistant'; content: Block[] }
export interface AnthropicRequest {
  model?: string;
  max_tokens: number;
  system?: Block[];
  messages: AnthropicMessage[];
  tools?: Block[];
  thinking?: Record<string, unknown>;
  stream?: boolean;
}

// The field an assistant message of the CURRENT turn carries its round's content
// blocks in, in the order the model wrote them, when that round held thinking. The
// Anthropic conversion replays it as it is — a thinking block must come back
// byte-identical, in its place, while the tool loop it belongs to runs. The OpenAI path
// never sees it (it is made only here), and `apiHistory` does not carry it into the
// next turn: the thinking of turns already over may be left out — the API ignores it
// there — and leaving out every earlier turn's is removing a LEADING run of thinking
// blocks, which keeps the current turn's valid.
export const ANTHROPIC_CONTENT = 'anthropicContent';

// ─── The request ──────────────────────────────────────────────────────────────

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return (content as ContentPart[]).filter((p) => p?.type === 'text').map((p) => (p as { text: string }).text).join('\n');
  return '';
};

// `data:image/png;base64,AAAA` → an image block; any other URL is passed as one.
export function imageBlock(url: string): Block {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  return { type: 'image', source: { type: 'url', url } };
}

function userBlocks(content: unknown): Block[] {
  if (Array.isArray(content)) {
    const out: Block[] = [];
    for (const p of content as ContentPart[]) {
      if (p?.type === 'text' && p.text) out.push({ type: 'text', text: p.text });
      else if (p?.type === 'image_url' && p.image_url?.url) out.push(imageBlock(p.image_url.url));
    }
    return out;
  }
  const text = textOf(content);
  return text ? [{ type: 'text', text }] : [];
}

// A call's arguments as the object `tool_use.input` must be. The loop refuses a call
// whose arguments do not parse before the history keeps it (it keeps "{}" instead), so
// this only guards a history written by hand.
function inputOf(args: unknown): Record<string, unknown> {
  if (typeof args !== 'string' || args === '') return {};
  try {
    const v = JSON.parse(args);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function assistantBlocks(m: ChatMessage): Block[] {
  const kept = m[ANTHROPIC_CONTENT];
  if (Array.isArray(kept) && kept.length) return kept as Block[];
  const out: Block[] = [];
  const text = textOf(m.content);
  if (text) out.push({ type: 'text', text });
  for (const c of (Array.isArray(m.tool_calls) ? m.tool_calls : []) as Array<{ id?: string; function?: { name?: string; arguments?: string } }>) {
    out.push({ type: 'tool_use', id: String(c.id ?? ''), name: String(c.function?.name ?? ''), input: inputOf(c.function?.arguments) });
  }
  return out;
}

// The loop tags every tool result `OK:` / `ERROR:` / `DECLINED:` for the model; the
// native API has a flag for the second.
function toolResultBlock(m: ChatMessage): Block {
  const text = textOf(m.content);
  return {
    type: 'tool_result',
    tool_use_id: String(m.tool_call_id ?? ''),
    ...(text ? { content: text } : {}),
    ...(text.startsWith('ERROR:') ? { is_error: true } : {}),
  };
}

// The host's OpenAI-shaped history → `system` + `messages`. System messages, wherever
// they stand (the prompt, /compact's summary), become top-level text blocks in order.
// Every other message becomes a user or assistant turn, and turns of one role in a row
// merge into one — the API wants them alternating, and a round's tool results must all
// be in the ONE user message after it. Within a user message the tool results come
// first, then any text (a message the person sent right after them). A message left
// with nothing to say is dropped: the API refuses an empty turn.
export function toAnthropicMessages(messages: ChatMessage[]): { system: Block[]; messages: AnthropicMessage[] } {
  const system: Block[] = [];
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = textOf(m.content);
      if (text) system.push({ type: 'text', text });
      continue;
    }
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = m.role === 'assistant' ? assistantBlocks(m) : m.role === 'tool' ? [toolResultBlock(m)] : userBlocks(m.content);
    if (!blocks.length) continue;
    const last = out.at(-1);
    if (last?.role === role) last.content = [...last.content, ...blocks];
    else out.push({ role, content: blocks });
  }
  for (const m of out) {
    if (m.role !== 'user') continue;
    const results = m.content.filter((b) => b.type === 'tool_result');
    if (results.length && results.length < m.content.length) m.content = [...results, ...m.content.filter((b) => b.type !== 'tool_result')];
  }
  return { system, messages: out };
}

export function toAnthropicTools(tools: ToolDef[] = []): Block[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    input_schema: t.function.parameters ?? { type: 'object', properties: {} },
  }) as unknown as Block);
}

// What `thinking` says, and the `max_tokens` beside it. A fixed budget must stay under
// max_tokens and cannot be below 1024; a ceiling set at or under the budget is raised
// by the budget, so the answer keeps the room it was given.
export function thinkingParams(thinking: ThinkingConfig | undefined, maxTokens: number): { thinking?: Record<string, unknown>; max_tokens: number } {
  if (thinking?.adaptive) return { thinking: { type: 'adaptive', display: 'summarized' }, max_tokens: maxTokens };
  if (thinking?.budgetTokens) {
    const budget = Math.max(MIN_THINKING_BUDGET, thinking.budgetTokens);
    return { thinking: { type: 'enabled', budget_tokens: budget }, max_tokens: maxTokens > budget ? maxTokens : budget + maxTokens };
  }
  return { max_tokens: maxTokens };
}

// The whole body. The cache breakpoints go on the last tool and the last system block:
// the tools and the system prompt are the prefix every round of a turn repeats.
export function anthropicRequest(
  messages: ChatMessage[],
  opts: { model?: string; maxTokens: number; thinking?: ThinkingConfig; tools?: ToolDef[]; stream: boolean },
): AnthropicRequest {
  const { system, messages: msgs } = toAnthropicMessages(messages);
  const tools = toAnthropicTools(opts.tools);
  const cached = (b: Block): Block => ({ ...b, cache_control: { type: 'ephemeral' } });
  if (tools.length) tools[tools.length - 1] = cached(tools.at(-1)!);
  if (system.length) system[system.length - 1] = cached(system.at(-1)!);
  return {
    model: opts.model,
    ...thinkingParams(opts.thinking, opts.maxTokens),
    ...(system.length ? { system } : {}),
    messages: msgs,
    ...(tools.length ? { tools } : {}),
    ...(opts.stream ? { stream: true } : {}),
  };
}

// Every thinking block taken out — the API's own recovery for a thinking block it
// will not take back (one bound to a history that has changed since it was written).
export function withoutThinking(body: AnthropicRequest): AnthropicRequest {
  return {
    ...body,
    messages: body.messages
      .map((m) => ({ ...m, content: m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') }))
      .filter((m) => m.content.length),
  };
}

const hasThinking = (body: AnthropicRequest) => body.messages.some((m) => m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'));

// ─── The response ─────────────────────────────────────────────────────────────

// An SSE `error` event carries no HTTP status; the error's type says which it would be.
const STATUS_OF: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};
export const errorStatus = (type: unknown): number => STATUS_OF[String(type)] ?? 500;

// The loop's words for why a round ended: `tool_calls` promises calls, `stop` an answer.
export function finishReason(stop: unknown): string {
  if (stop === 'tool_use') return 'tool_calls';
  if (stop === 'end_turn' || stop === 'stop_sequence') return 'stop';
  if (stop === 'max_tokens') return 'length';
  return typeof stop === 'string' ? stop : '';
}

type RawUsage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null | undefined;
// The prompt is everything sent — the part read from the cache and the part written to
// it are counted apart from `input_tokens` and are still in the window the meter shows.
export function usageOf(u: RawUsage): TokenUsage | undefined {
  if (!u || typeof u.input_tokens !== 'number') return undefined;
  return {
    promptTokens: u.input_tokens + Number(u.cache_creation_input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0),
    completionTokens: Number(u.output_tokens ?? 0),
  };
}

// One streamed round, folded event by event. Kept apart from the network so a test can
// feed it events. `on*` are the loop's live callbacks, the same as the OpenAI round's.
export function roundReader(cb: { onDelta?: (d: string) => void; onReasoning?: (d: string) => void; onToolCalls?: () => void; model?: string }) {
  const blocks: (Block & { json?: string })[] = [];
  let content = '';
  let reasoning = '';
  let stop: unknown = '';
  let raw: RawUsage;
  let error: { status: number; body: string } | null = null;
  let calls = 0;
  const event = (e: Record<string, any>) => {
    switch (e?.type) {
      case 'message_start':
        raw = { ...(e.message?.usage ?? {}) };
        break;
      case 'content_block_start': {
        const b = { ...(e.content_block ?? {}) } as Block & { json?: string };
        if (b.type === 'tool_use') {
          b.json = '';
          // The chat learns the round carries a call the moment one starts — as the
          // OpenAI round says it on the first fragment.
          if (!calls++) cb.onToolCalls?.();
        }
        if (b.type === 'text' && typeof b.text === 'string' && b.text) { content += b.text; cb.onDelta?.(b.text); }
        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) { reasoning += b.thinking; cb.onReasoning?.(b.thinking); }
        blocks[Number(e.index ?? blocks.length)] = b;
        break;
      }
      case 'content_block_delta': {
        const b = blocks[Number(e.index)];
        const d = e.delta ?? {};
        if (!b) break;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          b.text = String(b.text ?? '') + d.text;
          content += d.text;
          if (d.text) cb.onDelta?.(d.text);
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          b.json = (b.json ?? '') + d.partial_json;
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          b.thinking = String(b.thinking ?? '') + d.thinking;
          reasoning += d.thinking;
          // A thinking block whose text is not shown (the current models' default)
          // streams nothing but its signature — and an empty fold is not drawn.
          if (d.thinking) cb.onReasoning?.(d.thinking);
        } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
          b.signature = String(b.signature ?? '') + d.signature;
        }
        break;
      }
      case 'message_delta':
        if (e.delta?.stop_reason) stop = e.delta.stop_reason;
        // Cumulative: the last one holds the answer's whole count (and, on some
        // servers, the input's too).
        if (e.usage) raw = { ...(raw ?? {}), ...Object.fromEntries(Object.entries(e.usage).filter(([, v]) => typeof v === 'number')) };
        break;
      case 'error':
        error = { status: errorStatus(e.error?.type), body: JSON.stringify(e) };
        break;
      default: // ping, message_stop, content_block_stop, anything new
    }
  };
  const result = (): ChatRoundResult => {
    const toolCalls = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), arguments: b.json ?? '' }));
    // The round's blocks as they will go back: a call's input the object its
    // arguments parse to (the loop keeps "{}" for one that does not), no empty text
    // block (the API refuses one), nothing of the stream's own bookkeeping.
    const kept: Block[] = blocks.filter(Boolean).flatMap((b): Block[] => {
      const { json, ...rest } = b;
      if (rest.type === 'tool_use') return [{ type: 'tool_use', id: rest.id, name: rest.name, input: inputOf(json) }];
      if (rest.type === 'text') return rest.text ? [{ type: 'text', text: rest.text }] : [];
      return [rest as Block];
    });
    const thought = kept.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
    const usage = usageOf(raw);
    return {
      content,
      reasoning,
      finishReason: finishReason(stop) || (toolCalls.length ? 'tool_calls' : ''),
      toolCalls,
      ...(usage ? { usage } : {}),
      ...(thought && toolCalls.length ? { blocks: kept } : {}),
    };
  };
  return { event, result, error: () => error };
}

// ─── The network ──────────────────────────────────────────────────────────────

export interface AnthropicOpts {
  baseUrl?: string;
  model?: string;
  token?: string;
  maxTokens?: number;
  thinking?: ThinkingConfig;
  signal?: AbortSignal;
}

const endpoint = (baseUrl: string | undefined) => `${String(baseUrl ?? '').replace(/\/+$/, '')}/messages`;
const headers = (token: string): Record<string, string> => ({
  'x-api-key': token,
  'anthropic-version': ANTHROPIC_VERSION,
  'content-type': 'application/json',
});

async function post(body: AnthropicRequest, o: AnthropicOpts): Promise<Response> {
  const send = (b: AnthropicRequest) => fetch(endpoint(o.baseUrl), { method: 'POST', signal: o.signal, headers: headers(String(o.token)), body: JSON.stringify(b) });
  let res = await send(body);
  if (res.ok) return res;
  let text = await res.text().catch(() => '');
  // A thinking block the API will not take back (its history changed under it) is a
  // 400 naming the block; the API's own recovery is to send the history without any
  // thinking, once. The model answers without the reasoning those blocks carried.
  if (res.status === 400 && hasThinking(body) && /thinking|signature/i.test(text)) {
    res = await send(withoutThinking(body));
    if (res.ok) return res;
    text = await res.text().catch(() => '');
  }
  throw new Error(llmErrorMessage(res.status, text, { model: o.model, requestId: res.headers.get('request-id'), statusText: res.statusText }));
}

export async function anthropicChatRound(
  messages: ChatMessage[],
  o: AnthropicOpts & { tools?: ToolDef[]; onDelta?: (d: string) => void; onReasoning?: (d: string) => void; onToolCalls?: () => void },
): Promise<ChatRoundResult> {
  const body = anthropicRequest(messages, { model: o.model, maxTokens: o.maxTokens ?? 8192, thinking: o.thinking, tools: o.tools, stream: true });
  const res = await post(body, o);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('LLM: no response body');
  const requestId = res.headers.get('request-id');
  const round = roundReader({ onDelta: o.onDelta, onReasoning: o.onReasoning, onToolCalls: o.onToolCalls, model: o.model });
  const decoder = new TextDecoder();
  let buf = '';
  const line = (raw: string) => {
    const l = raw.trim();
    if (!l.startsWith('data:')) return; // `event:` lines name what `data` says again
    try { round.event(JSON.parse(l.slice(5).trim())); } catch { /* not JSON: skipped, as on the OpenAI wire */ }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      line(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
    const err = round.error();
    if (err) {
      await reader.cancel().catch(() => {});
      throw new Error(llmErrorMessage(err.status, err.body, { model: o.model, requestId }));
    }
  }
  if (buf) line(buf);
  const err = round.error();
  if (err) throw new Error(llmErrorMessage(err.status, err.body, { model: o.model, requestId }));
  return round.result();
}

// What /compact sends: calls and results as TEXT. The request carries no tools, and
// the API refuses tool_use / tool_result blocks in a request without them — a summary
// needs to read what was done, not to call anything. The conversation then starts
// with the person, as the API wants: the last 30 messages may begin mid-turn.
export function summaryHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = (m.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>).map((c) => `[called ${c.function?.name ?? '?'} ${c.function?.arguments || '{}'}]`);
      out.push({ role: 'assistant', content: [textOf(m.content), ...calls].filter(Boolean).join('\n') });
    } else if (m.role === 'tool') {
      out.push({ role: 'user', content: `[result: ${textOf(m.content)}]` });
    } else {
      const { [ANTHROPIC_CONTENT]: _kept, tool_calls: _c, ...rest } = m;
      out.push(rest as ChatMessage);
    }
  }
  const first = out.findIndex((m) => m.role !== 'system' && m.role !== 'assistant');
  return out.filter((m, i) => m.role === 'system' || (first >= 0 && i >= first));
}

// /compact's one-shot: the same conversion, not streamed, the answer's text blocks.
export async function anthropicCompact(messages: ChatMessage[], o: AnthropicOpts): Promise<string> {
  const body = anthropicRequest(summaryHistory(messages), { model: o.model, maxTokens: o.maxTokens ?? 8192, thinking: o.thinking, stream: false });
  const res = await post(body, o);
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  return (data?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
}
