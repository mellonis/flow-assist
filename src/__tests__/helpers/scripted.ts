// A scripted model and a booted app, shared by the end-to-end tests and by
// `scripts/ui-frames.ts`: the REAL app on a test backend, with only the network
// replaced. No key, no cost.
//
// A model turn is a list of steps: text (streamed in chunks), a tool call, text and a
// tool call in ONE chunk (`{ text, tool, args }` — a provider may send them together,
// and the chat must not lose the text when it does), or a `hold` that freezes the
// stream until `release()` — which is how a test acts, or a frame is taken, "while the
// answer is still coming". A `thinking` step is the model's reasoning (with the
// signature a thinking block carries on the Anthropic wire); an `error` step ends the
// stream with the provider's error event.
//
// Two wires: `wire = 'openai'` (the default) serves OpenAI-compatible chat-completion
// chunks; `wire = 'anthropic'` serves Anthropic's Messages API SSE and, like the real
// API, REFUSES a request it would refuse (`anthropicRefusal`) with its 400 — a double
// for a validating route must reject what the route rejects.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestBackend, flush } from '@flowtty/core/testing';
import { loadPlugins } from '../../loader/build.ts';
import { makeFactory, type Make, type Plugin } from '../../loader/plugin.ts';
import { assembleToolRegistry } from '../../loader/tools.ts';
import { renderApp } from '../../runtime/app.tsx';
import type { ClipboardImage } from '../../assistant/images.ts';
import type { InteractiveDeps } from '../../assistant/interactive.ts';
import { renderChatModal, renderHelp, renderLogModal, renderReminder } from '../../views/modals.ts';

export type Step =
  | { text: string } | { tool: string; args: unknown } | { text: string; tool: string; args: unknown } | { hold: true }
  | { thinking: string; signature: string } | { error: { type: string; message: string } };
export type Turn = Step[];

// ─── the scripted model ───────────────────────────────────────────────────────
export class ScriptedModel {
  private turns: Turn[] = [];
  private gate: (() => void) | null = null;
  requests: { messages: { role: string }[] }[] = [];
  // What each request was sent to, and with which headers (lower-cased names).
  urls: string[] = [];
  headers: Record<string, string>[] = [];
  wire: 'openai' | 'anthropic' = 'openai';
  // When set, every response ends with a usage chunk — as a provider asked for
  // `stream_options.include_usage` sends it.
  usage: { prompt_tokens: number; completion_tokens: number } | null = null;
  // The Anthropic wire's usage: `message_start` carries the input side, the final
  // `message_delta` the output. Unset: small fixed numbers.
  anthropicUsage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null = null;
  script(...turns: Turn[]) { this.turns.push(...turns); }
  release() { this.gate?.(); this.gate = null; }

  install() {
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      // A real fetch given a signal that is already aborted rejects before sending
      // anything — so a round started after Esc (a tool that returned once stopped)
      // never reaches the model.
      if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      this.requests.push(JSON.parse(String(init.body)));
      this.urls.push(String(_url));
      this.headers.push(Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)])));
      if (this.wire === 'anthropic') return this.anthropic(init);
      const turn = this.turns.shift() ?? [{ text: '(the script has no more turns)' }];
      // A request that does not ask for a stream (/compact's one-shot) gets plain JSON.
      if (!(this.requests.at(-1) as { stream?: boolean }).stream) {
        const text = turn.map((st) => ('text' in st ? st.text : '')).join('');
        return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { headers: { 'content-type': 'application/json' } });
      }
      const enc = new TextEncoder();
      const send = (c: ReadableStreamDefaultController, o: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      const self = this;
      const body = new ReadableStream({
        async start(c) {
          // Like a real fetch: aborting the request errors its body with an AbortError
          // (and lets a held step go), so Esc stops a scripted answer as it stops a real one.
          let stopped = false;
          init.signal?.addEventListener('abort', () => {
            stopped = true;
            c.error(new DOMException('The operation was aborted.', 'AbortError'));
            self.gate?.();
          });
          let calls = 0;
          // From a text-and-call step on, events are held back and go out in ONE
          // network chunk — up to the next hold, the end of the round included — as a
          // provider's last packet may carry all of it.
          let batch: string | null = null;
          const emit = (o: unknown) => { if (batch === null) send(c, o); else batch += `data: ${JSON.stringify(o)}\n\n`; };
          const flushBatch = () => { if (batch) c.enqueue(enc.encode(batch)); batch = null; };
          for (const step of turn) {
            if (stopped) return;
            if ('hold' in step) { flushBatch(); await new Promise<void>((r) => { self.gate = r; }); }
            else if ('thinking' in step) emit({ choices: [{ delta: { reasoning_content: step.thinking }, finish_reason: null }] });
            else if ('error' in step) continue;
            else if ('text' in step && 'tool' in step) { batch ??= ''; emit({ choices: [{ delta: { content: step.text, tool_calls: [{ index: calls, id: `call_${calls++}`, function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, finish_reason: null }] }); }
            else if ('text' in step) for (const piece of step.text.match(/.{1,12}/gs) ?? []) emit({ choices: [{ delta: { content: piece }, finish_reason: null }] });
            else emit({ choices: [{ delta: { tool_calls: [{ index: calls, id: `call_${calls++}`, function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, finish_reason: null }] });
          }
          if (stopped) return;
          emit({ choices: [{ delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] });
          if (self.usage) emit({ choices: [], usage: self.usage });
          if (batch === null) c.enqueue(enc.encode('data: [DONE]\n\n'));
          else { batch += 'data: [DONE]\n\n'; flushBatch(); }
          c.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
  }

  // ─── the Anthropic wire ─────────────────────────────────────────────────────
  private anthropic(init: RequestInit): Response {
    const req = this.requests.at(-1) as Record<string, unknown>;
    const refused = anthropicRefusal(req, this.headers.at(-1) ?? {});
    if (refused) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: refused } }), { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_scripted400' } });
    }
    const turn = this.turns.shift() ?? [{ text: '(the script has no more turns)' }];
    const u = this.anthropicUsage ?? { input_tokens: 10, output_tokens: 5 };
    if (!req.stream) {
      const text = turn.map((st) => ('text' in st ? st.text : '')).join('');
      return new Response(JSON.stringify({ id: 'msg_scripted', type: 'message', role: 'assistant', model: req.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: u }), { headers: { 'content-type': 'application/json', 'request-id': 'req_scripted' } });
    }
    const enc = new TextEncoder();
    const self = this;
    const body = new ReadableStream({
      async start(c) {
        let stopped = false;
        init.signal?.addEventListener('abort', () => {
          stopped = true;
          c.error(new DOMException('The operation was aborted.', 'AbortError'));
          self.gate?.();
        });
        let batch: string | null = null;
        const emit = (o: Record<string, unknown> & { type: string }) => {
          const s = `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
          if (batch === null) c.enqueue(enc.encode(s)); else batch += s;
        };
        const flushBatch = () => { if (batch) c.enqueue(enc.encode(batch)); batch = null; };
        const { output_tokens: _o, ...input } = u;
        emit({ type: 'message_start', message: { id: 'msg_scripted', type: 'message', role: 'assistant', model: req.model, content: [], stop_reason: null, usage: { ...input, output_tokens: 1 } } });
        emit({ type: 'ping' });
        let index = 0;
        let calls = 0;
        let open = false;
        const close = () => { if (open) { emit({ type: 'content_block_stop', index: index++ }); open = false; } };
        const text = (t: string) => {
          if (!open) { emit({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }); open = true; }
          for (const piece of t.match(/.{1,12}/gs) ?? []) emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
        };
        const tool = (name: string, args: unknown) => {
          close();
          emit({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${calls++}`, name, input: {} } });
          // The arguments arrive in pieces, as the real stream sends them.
          const json = JSON.stringify(args);
          const half = Math.ceil(json.length / 2);
          for (const piece of [json.slice(0, half), json.slice(half)]) if (piece) emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } });
          emit({ type: 'content_block_stop', index: index++ });
        };
        for (const step of turn) {
          if (stopped) return;
          if ('hold' in step) { flushBatch(); await new Promise<void>((r) => { self.gate = r; }); }
          else if ('error' in step) {
            flushBatch();
            emit({ type: 'error', error: step.error });
            c.close();
            return;
          } else if ('thinking' in step) {
            close();
            emit({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
            if (step.thinking) emit({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: step.thinking } });
            emit({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: step.signature } });
            emit({ type: 'content_block_stop', index: index++ });
          } else if ('text' in step && 'tool' in step) { batch ??= ''; text(step.text); tool(step.tool, step.args); }
          else if ('text' in step) text(step.text);
          else tool(step.tool, step.args);
        }
        if (stopped) return;
        close();
        emit({ type: 'message_delta', delta: { stop_reason: calls ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: u.output_tokens } });
        emit({ type: 'message_stop' });
        flushBatch();
        c.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_scripted' } });
  }
}

// Why the Messages API would refuse this request — null when it would take it. The
// rules the conversion must keep: the headers, a max_tokens, no field the API does not
// know, a conversation that starts with the person and alternates, every tool result
// answering a call of the turn right before it and standing first in its message, no
// empty text, a thinking budget under the ceiling, and a thinking block sent back only
// as it came (with its signature).
export function anthropicRefusal(req: Record<string, unknown>, headers: Record<string, string>): string | null {
  if (!headers['x-api-key']) return 'x-api-key header is required';
  if (!headers['anthropic-version']) return 'anthropic-version header is required';
  if (typeof req.max_tokens !== 'number') return 'max_tokens: Field required';
  const known = new Set(['model', 'max_tokens', 'system', 'messages', 'tools', 'thinking', 'stream', 'tool_choice', 'metadata', 'stop_sequences', 'temperature', 'top_p', 'top_k', 'output_config']);
  for (const k of Object.keys(req)) if (!known.has(k)) return `${k}: Extra inputs are not permitted`;
  const thinking = req.thinking as { type?: string; budget_tokens?: number } | undefined;
  if (thinking?.type === 'enabled' && !(Number(thinking.budget_tokens) >= 1024 && Number(thinking.budget_tokens) < (req.max_tokens as number))) return 'thinking.budget_tokens: must be at least 1024 and less than max_tokens';
  for (const [i, b] of ((req.system ?? []) as Array<Record<string, unknown>>).entries()) if (b.type !== 'text' || !b.text) return `system.${i}: text content blocks must be non-empty`;
  for (const [i, t] of ((req.tools ?? []) as Array<Record<string, unknown>>).entries()) {
    if (!t.name || !t.input_schema) return `tools.${i}: name and input_schema are required`;
    for (const k of Object.keys(t)) if (!['name', 'description', 'input_schema', 'cache_control'].includes(k)) return `tools.${i}.${k}: Extra inputs are not permitted`;
  }
  const msgs = (req.messages ?? []) as { role: string; content: Array<Record<string, unknown>> | string }[];
  if (!msgs.length || msgs[0]!.role !== 'user') return 'messages: the first message must use the "user" role';
  const toolBlocks = msgs.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result'));
  if (toolBlocks && !(req.tools as unknown[] | undefined)?.length) return 'Requests which include tool_use or tool_result blocks must define tools.';
  // A last message of the assistant's is a prefill — the start of the answer to go on
  // from. The current models refuse it, and with thinking on no model takes one.
  if (msgs.at(-1)!.role === 'assistant') return 'This model does not support assistant message prefill. The conversation must end with a user message.';
  const marked = [...((req.tools ?? []) as Array<Record<string, unknown>>), ...((req.system ?? []) as Array<Record<string, unknown>>), ...msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : []))]
    .filter((b) => b.cache_control).length;
  if (marked > 4) return `A maximum of 4 blocks with cache_control may be provided. Found ${marked}.`;
  // With a fixed thinking budget, the assistant turn a tool loop is answering must start
  // with its thinking block.
  if (thinking?.type === 'enabled') {
    const i = msgs.map((m) => m.role).lastIndexOf('assistant');
    const turn = msgs[i];
    const blocks = turn && Array.isArray(turn.content) ? turn.content : [];
    if (turn && i === msgs.length - 2 && blocks.some((b) => b.type === 'tool_use') && !['thinking', 'redacted_thinking'].includes(String(blocks[0]?.type))) {
      return `messages.${i}.content.0.type: Expected \`thinking\` or \`redacted_thinking\`, but found \`${blocks[0]?.type}\`. When \`thinking\` is enabled, a final \`assistant\` message must start with a thinking block.`;
    }
  }
  let asked = new Set<string>();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role !== 'user' && m.role !== 'assistant') return `messages.${i}.role: unexpected role "${m.role}"`;
    if (i && msgs[i - 1]!.role === m.role) return `messages: roles must alternate between "user" and "assistant" (messages.${i})`;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (!blocks.length) return `messages.${i}: all messages must have non-empty content`;
    let seenOther = false;
    for (const [j, b] of blocks.entries()) {
      if (b.type === 'text' && !b.text) return `messages.${i}.content.${j}.text: text content blocks must be non-empty`;
      if (b.type === 'thinking' && (m.role !== 'assistant' || typeof b.signature !== 'string' || !b.signature)) return `messages.${i}.content.${j}.thinking.signature: Field required`;
      if (b.type === 'tool_result') {
        if (m.role !== 'user') return `messages.${i}.content.${j}: tool_result in an assistant message`;
        if (seenOther) return `messages.${i}: tool_result blocks must come first in the content`;
        if (!asked.has(String(b.tool_use_id))) return `messages.${i}.content.${j}: unexpected tool_use_id found in tool_result blocks: ${b.tool_use_id}. Each tool_result block must have a corresponding tool_use block in the previous message.`;
      } else seenOther = true;
      if (b.type === 'image') {
        const src = b.source as { type?: string; media_type?: string; data?: string } | undefined;
        if (src?.type === 'base64' && (!src.media_type || !src.data || src.data.includes(','))) return `messages.${i}.content.${j}.image.source: invalid base64 source`;
      }
    }
    if (m.role === 'assistant') {
      const ids = blocks.filter((b) => b.type === 'tool_use').map((b) => String(b.id));
      if (ids.length) {
        const next = msgs[i + 1];
        const answered = new Set(((next?.content ?? []) as Array<Record<string, unknown>>).filter((b) => b.type === 'tool_result').map((b) => String(b.tool_use_id)));
        const missing = ids.find((id) => !answered.has(id));
        if (next && missing) return `messages.${i + 1}: tool_use ids were found without tool_result blocks immediately after: ${missing}`;
      }
      asked = new Set(ids);
    } else asked = new Set();
  }
  return null;
}

export const settle = async (n = 10) => { for (let i = 0; i < n; i++) { await flush(); await new Promise((r) => setTimeout(r, 4)); } };

// `guests` adds plugins that are not the host's own — built with the same `make` the
// loader uses, so they are namespaced exactly as an installed plugin is.
// `extra` is merged into the config — e.g. `{ memory: { file } }` to name the memory
// file a test then reads. `opts.toastMs` shortens the toast, for a test that waits
// for one to go. `opts.clipboardImage` stands in for the system clipboard's image; a
// test that does not give one has an empty clipboard — never the platform's real tools.
// `opts.chatMode` is where the chat opens: a WINDOW over the screen unless a test says
// otherwise — most tests are about what the chat draws, and their frames were written
// against the window. `null` leaves the config as the test gave it (a fresh config
// docks the chat as a panel), and a test whose `extra` says `mode` or `fullscreen` for
// the assistant is left alone too.
export async function bootApp(model: ScriptedModel, cols = 100, rows = 28, guests?: (make: Make) => Plugin[], extra: Record<string, unknown> = {}, opts: { toastMs?: number; scheme?: 'light' | 'dark' | 'unknown'; clipboardImage?: () => ClipboardImage; pluginsNote?: string; interactive?: InteractiveDeps; chatMode?: 'panel' | 'window' | 'full' | null } = {}) {
  process.env.LLM_TOKEN = 'scripted';
  model.install();
  // Sessions go to a fresh temp dir unless a test names one: a test must never write
  // into, or continue, the person's own saved chats.
  const sessions = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sessions-')) };
  // And so does the memory, for the same reason and one more: a stored fact rides in
  // every later request, so one test's memory read into the next test's system prompt.
  // `memoryFilePath` already keeps a test off the person's file; a file per boot is
  // what keeps the tests apart. A test that reads the file names its own through `extra`.
  const memory = { file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-memory-')), 'memory.json') };
  // Every tool in full (`toolLoading: 'all'`): a script calls whatever tool its test is
  // about, as a model that sees the whole list would. Tools on demand are tested on
  // their own, with `extra` giving an `ai` that does not say 'all'.
  const config: Record<string, unknown> = { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all' }, sessions, memory, ...extra };
  const chatMode = opts.chatMode === undefined ? 'window' : opts.chatMode;
  const assistant = (extra.plugins as Record<string, Record<string, unknown> | undefined> | undefined)?.assistant;
  if (chatMode && !(assistant && ('mode' in assistant || 'fullscreen' in assistant))) {
    config.plugins = { ...(config.plugins as Record<string, unknown> | undefined), assistant: { ...assistant, mode: chatMode } };
  }
  const repo = { enabledPlugins: async () => [], list: async () => [] } as never;
  const renders = { chat: renderChatModal, help: renderHelp, log: renderLogModal, reminder: renderReminder };
  const plugins = await loadPlugins({ config, repo, renders: renders as never });
  if (guests) plugins.push(...guests(makeFactory(config as never)));
  const tools = assembleToolRegistry({ plugins, config, repo });
  const backend = new TestBackend(cols, rows);
  // A dark terminal unless a test says otherwise: the look every frame here was written
  // against. `unknown` is the terminal that has not answered (TestBackend's own start).
  const scheme = opts.scheme ?? 'dark';
  if (scheme !== 'unknown') backend.setColorScheme(scheme, scheme === 'dark' ? '#000000' : '#ffffff');
  // How many times the app asked to exit — a key that quits is visible to a test.
  let exits = 0;
  const app = await renderApp(backend, { plugins, config, tools, onExit: () => { exits++; }, toastMs: opts.toastMs, pluginsNote: opts.pluginsNote, clipboardImage: opts.clipboardImage ?? (() => ({ ok: false, none: true, error: 'no image on the clipboard' })),
    // `!!command` never reaches the machine's own `script` or signals from a test: with
    // no `interactive` given, there is no `script`, the program "runs" at once and
    // exits 0, and the signal hold works on an emitter of its own.
    interactive: opts.interactive ?? { detect: () => null, spawn: async () => ({ code: 0, signal: null }), signals: new EventEmitter() } });
  await settle();
  const press = async (...names: string[]) => { for (const name of names) backend.press({ name }); await settle(); };
  const type = async (text: string) => { backend.type(text); await settle(); };
  return { backend, app, press, type, exits: () => exits };
}
