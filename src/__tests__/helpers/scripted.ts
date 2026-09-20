// A scripted model and a booted app, shared by the end-to-end tests and by
// `scripts/ui-frames.ts`: the REAL app on a test backend, with only the network
// replaced. No key, no cost.
//
// A model turn is a list of steps: text (streamed in chunks), a tool call, or a
// `hold` that freezes the stream until `release()` — which is how a test acts, or a
// frame is taken, "while the answer is still coming".

import { TestBackend, flush } from '@flowtty/core/testing';
import { loadPlugins } from '../../loader/build.ts';
import { assembleToolRegistry, execChatTool } from '../../loader/tools.ts';
import { renderApp } from '../../runtime/app.tsx';
import { renderChatModal, renderHelp, renderLogModal, renderReminder } from '../../views/modals.ts';

export type Step = { text: string } | { tool: string; args: unknown } | { hold: true };
export type Turn = Step[];

// ─── the scripted model ───────────────────────────────────────────────────────
export class ScriptedModel {
  private turns: Turn[] = [];
  private gate: (() => void) | null = null;
  requests: { messages: { role: string }[] }[] = [];
  script(...turns: Turn[]) { this.turns.push(...turns); }
  release() { this.gate?.(); this.gate = null; }

  install() {
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      this.requests.push(JSON.parse(String(init.body)));
      const turn = this.turns.shift() ?? [{ text: '(the script has no more turns)' }];
      const enc = new TextEncoder();
      const send = (c: ReadableStreamDefaultController, o: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      const self = this;
      const body = new ReadableStream({
        async start(c) {
          let calls = 0;
          for (const step of turn) {
            if ('hold' in step) await new Promise<void>((r) => { self.gate = r; });
            else if ('text' in step) for (const piece of step.text.match(/.{1,12}/gs) ?? []) send(c, { choices: [{ delta: { content: piece }, finish_reason: null }] });
            else send(c, { choices: [{ delta: { tool_calls: [{ index: calls, id: `call_${calls++}`, function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, finish_reason: null }] });
          }
          send(c, { choices: [{ delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] });
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
  }
}

export const settle = async (n = 10) => { for (let i = 0; i < n; i++) { await flush(); await new Promise((r) => setTimeout(r, 4)); } };

export async function bootApp(model: ScriptedModel, cols = 100, rows = 28) {
  process.env.LLM_TOKEN = 'scripted';
  model.install();
  const config: Record<string, unknown> = { ai: { baseUrl: 'http://scripted.model', model: 'scripted' } };
  const repo = { enabledPlugins: async () => [], list: async () => [] } as never;
  const renders = { chat: renderChatModal, help: renderHelp, log: renderLogModal, reminder: renderReminder };
  const plugins = await loadPlugins({ config, repo, renders: renders as never });
  const tools = assembleToolRegistry({ plugins, config, repo });
  // The plan is module-level state: every boot starts from an empty one.
  await execChatTool('todo', { action: 'clear' }, {}).catch(() => {});
  const backend = new TestBackend(cols, rows);
  const app = await renderApp(backend, { plugins, config, tools, onExit: () => {} });
  await settle();
  const press = async (...names: string[]) => { for (const name of names) backend.press({ name }); await settle(); };
  const type = async (text: string) => { backend.type(text); await settle(); };
  return { backend, app, press, type };
}
