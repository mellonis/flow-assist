// A call with the wrong arguments, through the real chat: `exec` never runs, the
// model reads a one-line error naming what is wrong, and a corrected call goes
// through — src/assistant/tool-args.ts, wired in `agentChat` (src/assistant/agent.ts).
import { expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import type { Make } from '../loader/plugin';

const settleUntil = async (ok: () => boolean, n = 100) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

type Sent = { messages: { role: string; content?: string | null }[] };
const sent = (model: ScriptedModel, i: number) => model.requests[i] as unknown as Sent;

async function ask(ui: Awaited<ReturnType<typeof bootApp>>, model: ScriptedModel, text: string, requests: number) {
  await ui.type(text);
  await ui.press('return');
  await settleUntil(() => model.requests.length >= requests);
  await settle(5);
}

// A plugin tool that requires `issueCode` — `code` is the name a model plausibly
// guesses instead.
const trackerPlugin = (make: Make, calls: Record<string, unknown>[]) => make('tracker', {
  tools: [{
    id: 'tracker',
    tools: [{
      type: 'function',
      function: {
        name: 'get_issue',
        description: 'Get an issue by its code.',
        parameters: { type: 'object', properties: { issueCode: { type: 'string' } }, required: ['issueCode'] },
      },
    }],
    exec: async (_name: string, args: Record<string, unknown>) => { calls.push(args); return `Issue ${args.issueCode}: open`; },
  }],
} as never);

test('a call naming the wrong parameter never reaches the tool; a corrected one does', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'get_issue', args: { code: 'ABC-1' } }],
    [{ tool: 'get_issue', args: { issueCode: 'ABC-1' } }],
    [{ text: 'It is open.' }],
  );
  const calls: Record<string, unknown>[] = [];
  const ui = await bootApp(model, 100, 28, (make) => [trackerPlugin(make, calls)]);
  await ui.press('F');
  // Three rounds run back to back with nothing to pause on between them, so the only
  // safe checkpoint is the end of the whole turn — `calls` (live, mutable) and
  // `model.requests` (a historical record once a request is sent) are both read only
  // once every round has run.
  await ask(ui, model, 'look up ABC-1', 3);

  // The bad call never ran, and the model was told why in one line it can act on —
  // round 2's own request carries round 1's tool result.
  expect(JSON.stringify(sent(model, 1).messages)).toContain(
    'ERROR: wrong arguments for get_issue — unknown `code` — did you mean `issueCode`? Nothing was run.',
  );
  // The corrected call ran exactly once, with exactly what the model sent — nothing
  // stripped, nothing filled in.
  expect(calls).toEqual([{ issueCode: 'ABC-1' }]);
  expect(JSON.stringify(sent(model, 2).messages)).toContain('OK: Issue ABC-1: open');
  expect(ui.backend.lastFrame).toContain('It is open.');
  ui.app.unmount();
});

test('a call missing a required parameter, with no unknown key to guess from, is named plainly', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'get_issue', args: {} }], [{ text: 'ok' }]);
  const calls: Record<string, unknown>[] = [];
  const ui = await bootApp(model, 100, 28, (make) => [trackerPlugin(make, calls)]);
  await ui.press('F');
  await ask(ui, model, 'look up an issue', 2);

  expect(calls.length).toBe(0);
  expect(JSON.stringify(sent(model, 1).messages)).toContain('ERROR: wrong arguments for get_issue — missing required parameter `issueCode`. Nothing was run.');
  ui.app.unmount();
});
