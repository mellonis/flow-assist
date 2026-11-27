// A long tool trail, and the end of a turn that never reached an answer.
//
// A turn that ran to the round limit printed one dim line per call — dozens of them —
// and with the folds open the screen was a sheet of grey. What the person needed (that
// the turn ended without an answer, and what it had actually done) was somewhere in
// the middle of it.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle, settleUntil } from './helpers/scripted';

import { nativeFetch } from './helpers/test-setup.ts';
import { hostColour } from './helpers/palette';
const realFetch = nativeFetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Ui = Awaited<ReturnType<typeof bootApp>>;
const rowsMatching = (ui: Ui, re: RegExp) => ui.backend.lastFrame.split('\n').filter((r) => re.test(r));

// One round, many calls: twelve of one tool in a row, then the two tools alternating.
const many = () => [
  ...Array.from({ length: 12 }, () => ({ tool: 'datetime', args: {} })),
  ...Array.from({ length: 24 }, (_, i) => ({ tool: i % 2 ? 'config_schema' : 'datetime', args: {} })),
];

test('consecutive calls of one tool are one record each in the expanded stretch', async () => {
  const model = new ScriptedModel();
  model.script(many(), [{ text: 'Done at last.' }]);
  // Tall enough for a good part of the trail to fit the conversation. Automatic
  // compaction is another mechanism, with its own tests: this turn's 36 calls would pass
  // the window and be folded into a handoff before its last answer.
  const ui = await bootApp(model, 110, 44, undefined, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', autoCompact: { enabled: false } } });
  await ui.press('F');
  await ui.type('do a lot');
  await ui.press('return');
  // Thirty-six rounds: the turn ends when the model says it does, not within a hop budget.
  await settleUntil(() => ui.backend.lastFrame.includes('Done at last.'), { ms: 15_000 });
  await settle(8);

  // Folded, the turn is one line — the stretch's own counts.
  expect(ui.backend.lastFrame).toContain('▸ + 36 tools');
  expect(ui.backend.lastFrame).not.toContain('datetime ×24');

  // Opened, one line per call, in the order they happened: a call is its own record,
  // never condensed into a count and never capped — the stretch's one line is what
  // keeps the screen quiet, not a second cap under it.
  const at = (needle: string) => ui.backend.lastFrame.split('\n').findIndex((r) => r.includes(needle));
  const click = async (y: number) => {
    ui.backend.mouse('down', 12, y);
    ui.backend.mouse('up', 12, y);
    await settle(8);
  };
  await click(at('+ 36 tools'));
  expect(rowsMatching(ui, /▸ ⌁ datetime · ok/).length).toBeGreaterThan(12);
  expect(ui.backend.lastFrame).not.toContain('earlier calls');
  expect(ui.backend.lastFrame).not.toContain('×24');
  // A record opens to its own body, and the others stay one line each.
  await click(at('⌁ datetime · ok'));
  expect(rowsMatching(ui, /→ ok/)).toHaveLength(1);
  expect(rowsMatching(ui, /▸ ⌁ datetime · ok/).length).toBeGreaterThan(12);
  ui.app.unmount();
}, 30_000);

test('the key opens every record\'s body one level at a time, a stretch of many calls included', async () => {
  const model = new ScriptedModel();
  model.script(many(), [{ text: 'Done at last.' }]);
  // As above: no automatic compaction, and a real budget for 36 rounds.
  const ui = await bootApp(model, 110, 60, undefined, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', autoCompact: { enabled: false } } });
  await ui.press('F');
  await ui.type('do a lot');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Done at last.'), { ms: 15_000 });
  await settle(8);
  // The first press opens the stretch: one record per call, no body out.
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(8);
  expect(rowsMatching(ui, /⌁ (datetime|config_schema) · ok/).length).toBeGreaterThan(12);
  expect(ui.backend.lastFrame).not.toContain('→ ok');
  // The second opens every record's body, one level down — its result under its line.
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(8);
  expect(rowsMatching(ui, /→ ok/).length).toBeGreaterThan(12);
  ui.app.unmount();
}, 30_000);

test('a turn with three calls looks exactly as it did', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'datetime', args: {} }, { tool: 'config_schema', args: {} }, { tool: 'datetime', args: {} }],
    [{ text: 'Three of them.' }],
  );
  const ui = await bootApp(model, 110, 34);
  await ui.press('F');
  await ui.type('do a little');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Three of them.'));
  await settle(8);
  expect(ui.backend.lastFrame).toContain('▸ + 3 tools');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(8);
  // Three calls, three records — nothing is condensed into a count, nothing is capped.
  expect(rowsMatching(ui, /▸ ⌁ (datetime|config_schema) · ok/)).toHaveLength(3);
  expect(ui.backend.lastFrame).not.toContain('earlier calls');
  expect(rowsMatching(ui, /▸ .*×/)).toHaveLength(0);
  ui.app.unmount();
});

test('a condensed group of failures still says why it failed', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'no_such_tool', args: {} }, { tool: 'no_such_tool', args: {} }, { tool: 'no_such_tool', args: {} }],
    [{ text: 'I could not.' }],
  );
  const ui = await bootApp(model, 110, 34);
  await ui.press('F');
  await ui.type('try the impossible');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('I could not.'));
  await settle(8);
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(8);
  // One record per failed call, and the reason — which is how a person knows why the
  // answer is thin — is the record's own body, a level down.
  expect(rowsMatching(ui, /▸ ⌁ no_such_tool · error/)).toHaveLength(3);
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(8);
  const line = rowsMatching(ui, /→ error/)[0] ?? '';
  expect(line).toMatch(/— .*Unknown tool/i);
  ui.app.unmount();
});

test('a turn that runs out of rounds says so where the answer would be, in the warn colour', async () => {
  const model = new ScriptedModel();
  // Every round carries a tool call, so the loop never reaches an answer.
  model.script(...Array.from({ length: 7 }, () => [{ tool: 'datetime', args: {} }]));
  const ui = await bootApp(model, 110, 30, undefined, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', maxRounds: 5 } });
  await ui.press('F');
  await ui.type('go round for ever');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('stopped after'), 900);
  await settle(8);
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('stopped after 5 rounds (ai.maxRounds) — ⏎ continue · last: datetime {}');
  // In the conversation, not on the dim hint line a wall of grey would otherwise hide.
  expect(frame).not.toContain('ran out of steps');
  const y = frame.split('\n').findIndex((r) => r.includes('stopped after 5 rounds'));
  const x = Array.from(frame.split('\n')[y]!.slice(0, frame.split('\n')[y]!.indexOf('stopped'))).length;
  const cell = (ui.backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { fg?: string; dim?: boolean } } } }).lastBuffer.get(x, y);
  expect(cell.style.fg).toBe(hostColour('dark', 'chat', 'warn')); // the chat's warn colour
  expect(cell.style.dim).toBeFalsy();
  ui.app.unmount();
});
