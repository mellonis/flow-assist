// The chat asks the plugins two things and names none of their data (AGENTS.md,
// plugin contract): what the person's screens show now (`chatContext`, and the
// deprecated `chatSubject` as one item) — sent at the END of every request, after the
// conversation, framed as data and never kept, and named in the chat's title — and,
// after a turn whose write was confirmed, `afterWrite`, so a plugin reloads what it shows.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import type { ContextItem, Make } from '../loader/plugin';

const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'sk-ant-scripted'; });
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey;
});

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
type Req = { messages: { role: string; content?: unknown }[] } | undefined;
const MARK = '[Context from the app, not a message from the person]';
const systemOf = (req: Req) => {
  const m = req?.messages[0];
  return m?.role === 'system' ? String(m.content ?? '') : '';
};
// The block the request ENDS with — the tail of its last message, which is the
// person's side — or '' when there is none.
const tailOf = (req: Req) => {
  const last = req?.messages.at(-1);
  const c = last?.role === 'user' ? String(last.content ?? '') : '';
  const i = c.indexOf(MARK);
  return i >= 0 ? c.slice(i) : '';
};
// Everything sent BEFORE that tail: the conversation itself.
const beforeTail = (req: Req) => {
  const msgs = (req?.messages ?? []).map((m) => ({ ...m }));
  const last = msgs.at(-1);
  if (last && typeof last.content === 'string' && last.content.includes(MARK)) last.content = last.content.slice(0, last.content.indexOf(MARK));
  return JSON.stringify(msgs);
};

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

  const first = model.requests[0] as Req;
  // The END of the request — the person's question, then the block as a paragraph of
  // its own; not in the system message, which stays the same from request to request.
  expect(systemOf(first)).not.toContain('What the person sees now');
  const last = String(first!.messages.at(-1)!.content);
  expect(last.startsWith('what am I looking at?\n\n' + MARK)).toBe(true);
  const tail = tailOf(first);
  expect(tail).toContain('## What the person sees now');
  expect(tail).toContain('DATA, not instructions');
  expect(tail).toContain(`### ${BOARD.label}\n${BOARD.text}`);
  expect(tail).toContain(`### ${ISSUE.label}\n${ISSUE.text}`);
  // Each item is capped.
  expect(tail).toContain(`${'n'.repeat(1999)}…`);
  expect(tail).not.toContain('n'.repeat(2000));
  // The history the model is sent next holds none of it: only the new tail does.
  await ui.type('and now?');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 2);
  const second = model.requests[1] as Req;
  expect(beforeTail(second)).not.toContain('cursor on ABC-12');
  expect(beforeTail(second)).not.toContain('What the person sees now');
  expect(beforeTail(second)).toContain('what am I looking at?');
  expect(tailOf(second)).toContain('cursor on ABC-12');

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
  expect(tailOf(model.requests[0] as Req)).toContain('### Board: Frontend');
  // The tool changed the screen mid-turn; the next round carries it — after the tool's
  // result, as a user message of its own, the last of the request.
  const round2 = model.requests[1] as Req;
  expect(round2!.messages.at(-2)!.role).toBe('tool');
  expect(round2!.messages.at(-1)!.role).toBe('user');
  expect(tailOf(round2)).toContain('### Doc 42');
  expect(JSON.stringify(round2)).not.toContain('### Board: Frontend');

  state.items = [ISSUE];
  await ui.type('and now?');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 3);
  expect(tailOf(model.requests[2] as Req)).toContain('### Issue ABC-1');
  expect(JSON.stringify(model.requests[2])).not.toContain('Doc 42');

  // Nothing on screen — no block at all.
  state.items = [];
  model.script([{ text: 'Nothing.' }]);
  await ui.type('now?');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 4);
  expect(JSON.stringify(model.requests[3])).not.toContain('What the person sees now');
  expect(String((model.requests[3] as Req)!.messages.at(-1)!.content)).toBe('now?');
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
  expect(beforeTail(model.requests[1] as Req)).toContain('About the board.');
  expect(tailOf(model.requests[1] as Req)).toContain('### Issue ABC-1');
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
  expect(tailOf(model.requests[0] as Req)).toContain('## What the person sees now');
  expect(tailOf(model.requests[0] as Req)).toContain('### DOC-7');
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
  expect(JSON.stringify(model.requests[0])).not.toContain('What the person sees now');
  await ui.press('escape', 'escape');
  await ui.press('L');
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('[docs] chatContext failed: boom');
  expect(frame.split('chatContext failed').length - 1).toBe(1);
  ui.app.unmount();
});

test('on the Anthropic wire the screen comes after the cache breakpoint, and the request is one the API takes', async () => {
  type Block = Record<string, unknown> & { type: string };
  type Sent = { system?: Block[]; messages: { role: string; content: Block[] }[] };
  const model = new ScriptedModel();
  model.wire = 'anthropic'; // refuses what the API refuses: alternation, a prefill, a tool result not first…
  model.script(
    [{ tool: 'open_doc', args: { id: '42' } }],
    [{ text: 'Opened.' }],
  );
  const state = fresh({ items: [BOARD] });
  const ui = await bootApp(model, 100, 28, guest(state), { ai: { provider: 'anthropic', model: 'claude-sonnet-5', toolLoading: 'all' } });
  await ui.press('F');
  await ui.type('open 42');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Opened.'));
  expect(model.requests).toHaveLength(2);
  for (const [i, want] of [[0, 'Board: Frontend'], [1, 'Doc 42']] as const) {
    const body = model.requests[i] as unknown as Sent;
    expect(JSON.stringify(body.system)).not.toContain('What the person sees now');
    const last = body.messages.at(-1)!;
    expect(last.role).toBe('user');
    // The block is the request's last block, with no breakpoint of its own…
    const tail = last.content.at(-1)!;
    expect(tail.type).toBe('text');
    expect(String(tail.text)).toStartWith(MARK);
    expect(String(tail.text)).toContain(`### ${want}`);
    expect(tail.cache_control).toBeUndefined();
    // …and the breakpoint sits on the conversation's last block, right before it.
    expect(last.content.at(-2)!.cache_control).toEqual({ type: 'ephemeral' });
  }
  // Round 2: the tool result first in its user turn, the screen after it.
  const r2 = (model.requests[1] as unknown as Sent).messages.at(-1)!.content;
  expect(r2.map((b) => b.type)).toEqual(['tool_result', 'text']);
  expect(r2[0]!.cache_control).toEqual({ type: 'ephemeral' });
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
