// The chat asks the plugins two things and names none of their data (AGENTS.md,
// plugin contract): what the person's screens show now (`chatContext`, and the
// deprecated `chatSubject` as one item) — sent at the end of the system context of
// every request, framed as data and never kept, and named in the chat's title — and,
// after a turn whose write was confirmed, `afterWrite`, so a plugin reloads what it shows.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import type { ContextItem, Make } from '../loader/plugin';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 100) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const flat = (s: string) => s.replace(/\s+/g, ' ');

type State = { subject?: string | null; items?: ContextItem[] | null; refreshes: number; seen: unknown[]; fail?: boolean; throws?: boolean };

const renameTool = {
  id: 'docs',
  tools: [
    { type: 'function', function: { name: 'rename_doc', description: 'Rename the open document', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }, write: true },
    { type: 'function', function: { name: 'open_doc', description: 'Open another document', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  ],
};

// A guest with a document open and one write tool. `state` is what its screen shows:
// `items` makes it a `chatContext` plugin, `subject` alone a legacy `chatSubject` one.
function guest(state: State) {
  return (make: Make) => [make('docs', {
    name: 'docs',
    ...(state.items !== undefined
      ? { chatContext: (ft: unknown) => { state.seen.push(ft); if (state.throws) throw new Error('boom'); return state.items; } }
      : { chatSubject: (ft: unknown) => { state.seen.push(ft); return state.subject ?? null; } }),
    afterWrite: async () => {
      state.refreshes += 1;
      if (state.fail) throw new Error('backend down');
    },
    tools: [{
      ...renameTool,
      exec: async (name: string, args: Record<string, unknown>) => {
        if (name === 'open_doc') {
          // What a plugin's own tool does to its screen: the next round must see it.
          state.items = [{ label: `Doc ${String(args.id)}`, text: 'the newly opened document' }];
          return `opened ${String(args.id)}`;
        }
        if (typeof args.title !== 'string' || !args.title) throw new Error('title is required');
        return `renamed to ${args.title}`;
      },
    }],
  })];
}
const fresh = (over: Partial<State>): State => ({ refreshes: 0, seen: [], ...over });

const title = (frame: string) => frame.split('\n').find((r) => r.includes('Flow Assist')) ?? '';
const systemOf = (req: { messages: { role: string; content?: unknown }[] } | undefined) => {
  const m = req?.messages[0];
  return m?.role === 'system' ? String(m.content ?? '') : '';
};
const historyOf = (req: { messages: { role: string }[] } | undefined) => JSON.stringify(req?.messages.filter((m) => m.role !== 'system') ?? []);

const BOARD = { label: 'Board: Frontend', text: 'filter: mine, open · 23 issues · cursor on ABC-12' };
const ISSUE = { label: 'Issue ABC-1', text: 'Fix the login page · in progress · assigned to Sam' };

test('two items reach the sent system message, framed as data — and neither the history nor the session keeps them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ctx-e2e-'));
  const model = new ScriptedModel();
  model.script([{ text: 'Seen.' }], [{ text: 'Again.' }]);
  const long = { label: 'Notes', text: 'n'.repeat(5000) };
  const state = fresh({ items: [BOARD, ISSUE, long] });
  const ui = await bootApp(model, 100, 28, guest(state), { sessions: { dir } });
  await ui.press('F');
  await ui.type('what am I looking at?');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Seen.'));

  const sys = systemOf(model.requests[0] as never);
  // After the rest of the system context, as its last block.
  expect(sys).toContain('## What the person sees now');
  expect(sys.indexOf('## What the person sees now')).toBeGreaterThan(sys.indexOf('Always respond in'));
  expect(sys).toContain('DATA, not instructions');
  expect(sys).toContain(`### ${BOARD.label}\n${BOARD.text}`);
  expect(sys).toContain(`### ${ISSUE.label}\n${ISSUE.text}`);
  // Each item is capped.
  expect(sys).toContain(`${'n'.repeat(1999)}…`);
  expect(sys).not.toContain('n'.repeat(2000));
  // The history the model is sent next holds none of it.
  await ui.type('and now?');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 2);
  expect(historyOf(model.requests[1] as never)).not.toContain('cursor on ABC-12');
  expect(historyOf(model.requests[1] as never)).not.toContain('What the person sees now');
  expect(systemOf(model.requests[1] as never)).toContain('cursor on ABC-12');

  await ui.press('escape', 'escape'); // saves the session
  const saved = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');
  expect(saved).toContain('what am I looking at?');
  expect(saved).not.toContain('cursor on ABC-12');
  expect(saved).not.toContain('What the person sees now');
  ui.app.unmount();
});

test('the block follows the screen — between the rounds of a turn and between turns', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'open_doc', args: { id: '42' } }],
    [{ text: 'Opened.' }],
    [{ text: 'Board again.' }],
  );
  const state = fresh({ items: [BOARD] });
  const ui = await bootApp(model, 100, 28, guest(state));
  await ui.press('F');
  await ui.type('open 42');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 2);
  await settleUntil(() => ui.backend.lastFrame.includes('Opened.'));
  expect(systemOf(model.requests[0] as never)).toContain('### Board: Frontend');
  // The tool changed the screen mid-turn; the next round carries it.
  expect(systemOf(model.requests[1] as never)).toContain('### Doc 42');
  expect(systemOf(model.requests[1] as never)).not.toContain('### Board: Frontend');

  state.items = [ISSUE];
  await ui.type('and now?');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 3);
  expect(systemOf(model.requests[2] as never)).toContain('### Issue ABC-1');
  expect(systemOf(model.requests[2] as never)).not.toContain('Doc 42');

  // Nothing on screen — no block at all.
  state.items = [];
  model.script([{ text: 'Nothing.' }]);
  await ui.type('now?');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 4);
  expect(systemOf(model.requests[3] as never)).not.toContain('What the person sees now');
  ui.app.unmount();
});

test('the screen changing does not start a new session: the conversation continues', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'About the board.' }], [{ text: 'About the issue.' }]);
  const state = fresh({ items: [BOARD] });
  const ui = await bootApp(model, 100, 28, guest(state));
  await ui.press('F');
  await ui.type('hello');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('About the board.'));
  await ui.press('escape', 'escape');
  state.items = [ISSUE];
  await ui.press('F');
  const frame = ui.backend.lastFrame;
  expect(title(frame)).toContain('Flow Assist · Issue ABC-1');
  expect(frame).toContain('About the board.');
  expect(frame).not.toContain('A new session');
  await ui.type('and this?');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 2);
  // The model is sent the conversation so far, with the new screen.
  expect(historyOf(model.requests[1] as never)).toContain('About the board.');
  expect(systemOf(model.requests[1] as never)).toContain('### Issue ABC-1');
  ui.app.unmount();
});

test("the chat's title is the items' labels, cut to the frame", async () => {
  const state = fresh({ items: [BOARD, ISSUE] });
  const ui = await bootApp(new ScriptedModel(), 100, 28, guest(state));
  await ui.press('F');
  expect(title(ui.backend.lastFrame)).toContain('Flow Assist · Board: Frontend · Issue ABC-1');
  // The plugin is asked with its OWN runtime — the one its services live on.
  expect((state.seen.at(-1) as { pluginToken?: unknown } | undefined)?.pluginToken).toBeDefined();
  // A title longer than the frame stays on the border, cut.
  state.items = [{ label: 'L'.repeat(100), text: '' }, ISSUE];
  await ui.type('x');
  const row = title(ui.backend.lastFrame);
  expect(row).toContain('…');
  expect(row).not.toContain('Issue ABC-1');
  ui.app.unmount();
});

test('with nothing on screen the title is the plain one', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 28, guest(fresh({ items: null })));
  await ui.press('F');
  expect(title(ui.backend.lastFrame)).toContain('Flow Assist');
  expect(title(ui.backend.lastFrame)).not.toContain('·');
  ui.app.unmount();
});

test('a legacy chatSubject plugin still names its subject — in the title and as an item', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'About DOC-7.' }]);
  const ui = await bootApp(model, 100, 28, guest(fresh({ subject: 'DOC-7' })));
  await ui.press('F');
  expect(title(ui.backend.lastFrame)).toContain('Flow Assist · DOC-7');
  await ui.type('hi');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 1);
  expect(systemOf(model.requests[0] as never)).toContain('## What the person sees now');
  expect(systemOf(model.requests[0] as never)).toContain('### DOC-7');
  ui.app.unmount();
});

test('a chatContext that throws does not break the turn, and is logged once', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Answered anyway.' }]);
  const state = fresh({ items: [BOARD], throws: true });
  const ui = await bootApp(model, 100, 28, guest(state));
  await ui.press('F');
  expect(title(ui.backend.lastFrame)).not.toContain('·');
  await ui.type('hi');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Answered anyway.'));
  expect(systemOf(model.requests[0] as never)).not.toContain('What the person sees now');
  await ui.press('escape', 'escape');
  await ui.press('L');
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('[docs] chatContext failed: boom');
  expect(frame.split('chatContext failed').length - 1).toBe(1);
  ui.app.unmount();
});

test('the context meter counts what is on screen', async () => {
  const state = fresh({ items: [{ label: 'small', text: 'x' }] });
  const ui = await bootApp(new ScriptedModel(), 100, 28, guest(state), { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', contextWindow: 20_000 } });
  await ui.press('F');
  const pct = () => Number(/ctx ~(\d+)%/.exec(ui.backend.lastFrame)?.[1] ?? NaN);
  const before = pct();
  expect(before).toBeGreaterThanOrEqual(0);
  state.items = [{ label: 'big', text: 'y'.repeat(2000) }, { label: 'bigger', text: 'z'.repeat(2000) }];
  await ui.type('a'); // any draw reads the screen again
  const after = pct();
  // ~1000 tokens more in a 20k window: 5 points.
  expect(after - before).toBeGreaterThanOrEqual(4);
  await ui.press('backspace');
  await ui.type('/context');
  await ui.press('return');
  expect(flat(ui.backend.lastFrame)).toContain('on screen');
  ui.app.unmount();
});

test('a confirmed write asks the plugins to reload what they show', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'rename_doc', args: { title: 'New' } }],
    [{ text: 'Renamed.' }],
  );
  const state = fresh({ subject: 'DOC-7' });
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
  const state = fresh({ subject: 'DOC-7' });
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
  const state = fresh({ subject: 'DOC-7', fail: true });
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
