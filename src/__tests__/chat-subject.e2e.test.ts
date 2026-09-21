// The chat asks the plugins two things and names none of their data (AGENTS.md,
// plugin contract): what the screen is about now (`chatSubject`) — shown in the
// chat's title, and a new conversation when it changes — and, after a turn whose
// write was confirmed, `afterWrite`, so a plugin reloads what it shows.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import type { Make } from '../loader/plugin';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 100) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

// A guest with a document open and one write tool. `state` is what its screen shows.
function guest(state: { subject: string | null; refreshes: number; seen: unknown[]; fail?: boolean }) {
  return (make: Make) => [make('docs', {
    name: 'docs',
    chatSubject: (ft: unknown) => {
      state.seen.push(ft);
      return state.subject;
    },
    afterWrite: async () => {
      state.refreshes += 1;
      if (state.fail) throw new Error('backend down');
    },
    tools: [{
      id: 'docs',
      tools: [{ type: 'function', function: { name: 'rename_doc', description: 'Rename the open document', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }, write: true }],
      exec: async (_name: string, args: Record<string, unknown>) => {
        if (typeof args.title !== 'string' || !args.title) throw new Error('title is required');
        return `renamed to ${args.title}`;
      },
    }],
  })];
}

const title = (frame: string) => frame.split('\n').find((r) => r.includes('Flow Assist')) ?? '';

test("the chat's title names what the plugin's screen is about", async () => {
  const state = { subject: 'DOC-7' as string | null, refreshes: 0, seen: [] as unknown[] };
  const ui = await bootApp(new ScriptedModel(), 100, 28, guest(state));
  await ui.press('F');
  expect(title(ui.backend.lastFrame)).toContain('Flow Assist · DOC-7');
  // The plugin is asked with its OWN runtime — the one its services live on.
  expect((state.seen.at(-1) as { pluginToken?: unknown } | undefined)?.pluginToken).toBeDefined();
  ui.app.unmount();
});

test('with nothing named the title is the plain one', async () => {
  const state = { subject: null as string | null, refreshes: 0, seen: [] as unknown[] };
  const ui = await bootApp(new ScriptedModel(), 100, 28, guest(state));
  await ui.press('F');
  expect(title(ui.backend.lastFrame)).toContain('Flow Assist');
  expect(title(ui.backend.lastFrame)).not.toContain('·');
  ui.app.unmount();
});

test('a confirmed write asks the plugins to reload what they show', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'rename_doc', args: { title: 'New' } }],
    [{ text: 'Renamed.' }],
  );
  const state = { subject: 'DOC-7' as string | null, refreshes: 0, seen: [] as unknown[] };
  const ui = await bootApp(model, 100, 28, guest(state));
  await ui.press('F');
  await ui.type('rename it');
  await ui.press('return');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Confirm write: rename_doc');
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  await settleUntil(() => state.refreshes > 0);
  expect(state.refreshes).toBe(1);
  ui.app.unmount();
});

test('a declined write, or a write that failed, reloads nothing', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'rename_doc', args: { title: 'New' } }],
    [{ text: 'Left it.' }],
    [{ tool: 'rename_doc', args: { title: '' } }],
    [{ text: 'It refused.' }],
  );
  const state = { subject: 'DOC-7' as string | null, refreshes: 0, seen: [] as unknown[] };
  const ui = await bootApp(model, 100, 28, guest(state));
  await ui.press('F');
  await ui.type('rename it');
  await ui.press('return');
  await settle(10);
  await ui.press('n');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  await ui.type('try an empty title');
  await ui.press('return');
  await settle(10);
  await ui.press('y');
  await settleUntil(() => model.requests.length === 4);
  await settle(10);
  expect(state.refreshes).toBe(0);
  ui.app.unmount();
});

test("a plugin's failed reload is logged, not thrown", async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'rename_doc', args: { title: 'New' } }],
    [{ text: 'Renamed.' }],
  );
  const state = { subject: 'DOC-7' as string | null, refreshes: 0, seen: [] as unknown[], fail: true };
  const ui = await bootApp(model, 100, 28, guest(state));
  await ui.press('F');
  await ui.type('rename it');
  await ui.press('return');
  await settle(10);
  await ui.press('y');
  await settleUntil(() => model.requests.length === 2);
  await settle(10);
  expect(state.refreshes).toBe(1);
  await ui.press('escape', 'escape');
  await ui.press('L');
  expect(ui.backend.lastFrame).toContain('[docs] refresh after a write failed: backend down');
  ui.app.unmount();
});

test('opening the chat on another subject starts a new conversation', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'About DOC-7.' }]);
  const state = { subject: 'DOC-7' as string | null, refreshes: 0, seen: [] as unknown[] };
  const ui = await bootApp(model, 100, 28, guest(state));
  await ui.press('F');
  await ui.type('hello');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('About DOC-7.'));
  await ui.press('escape', 'escape');
  state.subject = 'DOC-8';
  await ui.press('F');
  expect(title(ui.backend.lastFrame)).toContain('Flow Assist · DOC-8');
  expect(ui.backend.lastFrame).not.toContain('About DOC-7.');
  ui.app.unmount();
});
