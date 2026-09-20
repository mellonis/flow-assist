// Scripted conversations for looking at the chat UI.
//
//   bun scripts/ui-frames.ts                 # every scenario
//   bun scripts/ui-frames.ts streaming bg    # only these
//   bun scripts/ui-frames.ts --size 120x36 streaming
//
// Each scenario boots the REAL app on a test backend, plays a scripted model
// (no network, no key, no cost) and prints the frame at named checkpoints. It is
// how a display change gets looked at before and after: the same script, the same
// moments, two outputs to compare. It asserts nothing — behaviour belongs in the
// tests, this is for eyes.
//
// A model turn is a list of steps: text (streamed in chunks), a tool call, or a
// `hold` that freezes the stream until the scenario releases it — which is how a
// frame is taken "while the answer is still coming".

import { TestBackend, flush } from '@flowtty/core/testing';
import { loadPlugins } from '../src/loader/build.ts';
import { assembleToolRegistry } from '../src/loader/tools.ts';
import { renderApp } from '../src/runtime/app.tsx';
import { renderChatModal, renderHelp, renderLogModal, renderReminder } from '../src/views/modals.ts';

type Step = { text: string } | { tool: string; args: unknown } | { hold: true };
type Turn = Step[];

const argv = process.argv.slice(2);
const sizeAt = argv.indexOf('--size');
const [W, H] = (sizeAt >= 0 ? argv[sizeAt + 1]! : '100x28').split('x').map(Number) as [number, number];
const wanted = argv.filter((a, i) => !a.startsWith('--') && !(sizeAt >= 0 && i === sizeAt + 1));

// ─── the scripted model ───────────────────────────────────────────────────────
class ScriptedModel {
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

// ─── the rig ──────────────────────────────────────────────────────────────────
const settle = async (n = 10) => { for (let i = 0; i < n; i++) { await flush(); await new Promise((r) => setTimeout(r, 4)); } };

async function boot(model: ScriptedModel) {
  process.env.LLM_TOKEN = 'scripted';
  model.install();
  const config: Record<string, unknown> = { ai: { baseUrl: 'http://scripted.model', model: 'scripted' } };
  const repo = { enabledPlugins: async () => [], list: async () => [] } as never;
  const renders = { chat: renderChatModal, help: renderHelp, log: renderLogModal, reminder: renderReminder };
  const plugins = await loadPlugins({ config, repo, renders: renders as never });
  const tools = assembleToolRegistry({ plugins, config, repo });
  const backend = new TestBackend(W, H);
  const app = await renderApp(backend, { plugins, config, tools, onExit: () => {} });
  await settle();
  const frame = (title: string) => {
    const lines = backend.lastFrame.split('\n').map((l) => l.replace(/\s+$/, ''));
    while (lines.length && !lines.at(-1)) lines.pop();
    console.log(`\n┏━━ ${title}\n${lines.join('\n')}`);
  };
  const press = async (...names: string[]) => { for (const name of names) backend.press({ name }); await settle(); };
  const type = async (text: string) => { backend.type(text); await settle(); };
  return { backend, app, frame, press, type };
}

// ─── scenarios ────────────────────────────────────────────────────────────────
const scenarios: Record<string, () => Promise<void>> = {
  // The input field in every state a person meets it in.
  async input() {
    const model = new ScriptedModel();
    const ui = await boot(model);
    ui.frame('app started, chat closed');
    await ui.press('A');
    ui.frame('chat opened, field empty');
    await ui.type('a question being typed');
    ui.frame('text in the field');
    ui.app.unmount();
  },

  // A multi-line draft: two thoughts separated by a blank line.
  async multiline() {
    const ui = await boot(new ScriptedModel());
    await ui.press('A');
    await ui.type('first thought');
    ui.backend.press({ name: 'return', shift: true });
    ui.backend.press({ name: 'return', shift: true });
    await ui.type('second thought');
    ui.frame('two thoughts with a blank line between them');
    ui.app.unmount();
  },

  // What happens to a message sent WHILE an answer is still streaming.
  async streaming() {
    const model = new ScriptedModel();
    model.script([{ text: 'Looking at the branch now, ' }, { hold: true }, { text: 'and it is three commits ahead of master.' }], [{ text: 'Second answer.' }]);
    const ui = await boot(model);
    await ui.press('A');
    await ui.type('how far is my branch from master');
    await ui.press('return');
    ui.frame('answer streaming, field idle');
    await ui.type('and is CI green');
    ui.frame('typed while the answer streams');
    await ui.press('return');
    ui.frame('pressed Enter while the answer streams');
    model.release();
    await settle(16);
    ui.frame('first answer finished');
    console.log(`   requests sent to the model so far: ${model.requests.length}`);
    ui.app.unmount();
  },

  // A tool-using turn: the trail of calls under the answer.
  async tools() {
    const model = new ScriptedModel();
    model.script(
      [{ text: 'Let me put that in the plan.' }, { tool: 'todo', args: { action: 'add', items: ['read the diff', 'run the tests', 'write the summary'] } }],
      [{ tool: 'todo', args: { action: 'start', text: 'read the diff' } }],
      [{ text: 'Plan is set and the first item is in progress.' }],
    );
    const ui = await boot(model);
    await ui.press('A');
    await ui.type('plan the review of this branch');
    await ui.press('return');
    await settle(20);
    ui.frame('answer with a tool trail and a live plan');
    ui.app.unmount();
  },

  // A background task: how its result lands in the conversation.
  async bg() {
    const model = new ScriptedModel();
    model.script(
      [{ tool: 'background', args: { task: 'count the TODO comments in the repo' } }],
      [{ text: 'Started it in the background.' }],
      [{ text: 'There are 14 TODO comments.' }], // the nested run
      [{ text: 'The background task finished: 14 TODO comments.' }], // the reply to its result
    );
    const ui = await boot(model);
    await ui.press('A');
    await ui.type('count the TODOs in the background');
    await ui.press('return');
    await settle(12);
    ui.frame('task handed to the background');
    await ui.type('meanwhile, a new question');
    ui.frame('typing while the background task runs');
    await settle(40);
    ui.frame('background result arrived');
    ui.app.unmount();
  },

  // The two pauses: a structured question, and a write confirmation.
  async pauses() {
    const model = new ScriptedModel();
    model.script(
      [{ tool: 'ask_user', args: { questions: [{ question: 'Rebase or merge?', header: 'Strategy', options: [{ label: 'rebase (Recommended)', description: 'Linear history' }, { label: 'merge', description: 'Keeps the branch shape' }] }] } }],
      [{ tool: 'memory', args: { action: 'add', text: 'This repo prefers rebase over merge.' } }],
      [{ text: 'Noted.' }],
    );
    const ui = await boot(model);
    await ui.press('A');
    await ui.type('how should I integrate this');
    await ui.press('return');
    await settle(12);
    ui.frame('ask_user open');
    await ui.press('return');
    await settle(12);
    ui.frame('after the answer (a write may be asking for confirmation)');
    ui.app.unmount();
  },
};

const names = wanted.length ? wanted : Object.keys(scenarios);
for (const name of names) {
  const run = scenarios[name];
  if (!run) { console.error(`unknown scenario "${name}" — have: ${Object.keys(scenarios).join(', ')}`); process.exit(2); }
  console.log(`\n\n════════ ${name} (${W}×${H}) ════════`);
  await run();
}
process.exit(0);
