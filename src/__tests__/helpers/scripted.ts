// A scripted model and a booted app, shared by the end-to-end tests and by
// `scripts/ui-frames.ts`: the REAL app on a test backend, with only the network
// replaced. No key, no cost.
//
// A model turn is a list of steps: text (streamed in chunks), a tool call, or a
// `hold` that freezes the stream until `release()` — which is how a test acts, or a
// frame is taken, "while the answer is still coming".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestBackend, flush } from '@flowtty/core/testing';
import { loadPlugins } from '../../loader/build.ts';
import { makeFactory, type Make, type Plugin } from '../../loader/plugin.ts';
import { assembleToolRegistry } from '../../loader/tools.ts';
import { renderApp } from '../../runtime/app.tsx';
import type { ClipboardImage } from '../../assistant/images.ts';
import { renderChatModal, renderHelp, renderLogModal, renderReminder } from '../../views/modals.ts';

export type Step = { text: string } | { tool: string; args: unknown } | { hold: true };
export type Turn = Step[];

// ─── the scripted model ───────────────────────────────────────────────────────
export class ScriptedModel {
  private turns: Turn[] = [];
  private gate: (() => void) | null = null;
  requests: { messages: { role: string }[] }[] = [];
  // When set, every response ends with a usage chunk — as a provider asked for
  // `stream_options.include_usage` sends it.
  usage: { prompt_tokens: number; completion_tokens: number } | null = null;
  script(...turns: Turn[]) { this.turns.push(...turns); }
  release() { this.gate?.(); this.gate = null; }

  install() {
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      // A real fetch given a signal that is already aborted rejects before sending
      // anything — so a round started after Esc (a tool that returned once stopped)
      // never reaches the model.
      if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      this.requests.push(JSON.parse(String(init.body)));
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
          for (const step of turn) {
            if (stopped) return;
            if ('hold' in step) await new Promise<void>((r) => { self.gate = r; });
            else if ('text' in step) for (const piece of step.text.match(/.{1,12}/gs) ?? []) send(c, { choices: [{ delta: { content: piece }, finish_reason: null }] });
            else send(c, { choices: [{ delta: { tool_calls: [{ index: calls, id: `call_${calls++}`, function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, finish_reason: null }] });
          }
          if (stopped) return;
          send(c, { choices: [{ delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] });
          if (self.usage) send(c, { choices: [], usage: self.usage });
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
  }
}

export const settle = async (n = 10) => { for (let i = 0; i < n; i++) { await flush(); await new Promise((r) => setTimeout(r, 4)); } };

// `guests` adds plugins that are not the host's own — built with the same `make` the
// loader uses, so they are namespaced exactly as an installed plugin is.
// `extra` is merged into the config — e.g. `{ memory: { file } }` to name the memory
// file a test then reads. `opts.toastMs` shortens the toast, for a test that waits
// for one to go. `opts.clipboardImage` stands in for the system clipboard's image; a
// test that does not give one has an empty clipboard — never the platform's real tools.
export async function bootApp(model: ScriptedModel, cols = 100, rows = 28, guests?: (make: Make) => Plugin[], extra: Record<string, unknown> = {}, opts: { toastMs?: number; scheme?: 'light' | 'dark' | 'unknown'; clipboardImage?: () => ClipboardImage; pluginsNote?: string } = {}) {
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
  const app = await renderApp(backend, { plugins, config, tools, onExit: () => { exits++; }, toastMs: opts.toastMs, pluginsNote: opts.pluginsNote, clipboardImage: opts.clipboardImage ?? (() => ({ ok: false, none: true, error: 'no image on the clipboard' })) });
  await settle();
  const press = async (...names: string[]) => { for (const name of names) backend.press({ name }); await settle(); };
  const type = async (text: string) => { backend.type(text); await settle(); };
  return { backend, app, press, type, exits: () => exits };
}
