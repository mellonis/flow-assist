// A long tool trail, and the end of a turn that never reached an answer.
//
// A turn that ran to the round limit printed one dim line per call — dozens of them —
// and with the folds open the screen was a sheet of grey. What the person needed (that
// the turn ended without an answer, and what it had actually done) was somewhere in
// the middle of it.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Ui = Awaited<ReturnType<typeof bootApp>>;
const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const rowsMatching = (ui: Ui, re: RegExp) => ui.backend.lastFrame.split('\n').filter((r) => re.test(r));

// One round, many calls: twelve of one tool in a row, then the two tools alternating.
const many = () => [
  ...Array.from({ length: 12 }, () => ({ tool: 'datetime', args: {} })),
  ...Array.from({ length: 24 }, (_, i) => ({ tool: i % 2 ? 'config_schema' : 'datetime', args: {} })),
];

test('consecutive calls of one tool are one line with a count, and the open trail is capped', async () => {
  const model = new ScriptedModel();
  model.script(many(), [{ text: 'Done at last.' }]);
  const ui = await bootApp(model, 110, 40);
  await ui.press('F');
  await ui.type('do a lot');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Done at last.'));
  await settle(8);

  // Folded, the turn is one line — and it says what each tool cost in calls.
  expect(ui.backend.lastFrame).toContain('36 tools:');
  expect(ui.backend.lastFrame).toMatch(/datetime ×24/);
  expect(ui.backend.lastFrame).toMatch(/config_schema ×12/);

  // Opened with a click on the turn's own line — the trail of THAT turn, capped.
  const summary = ui.backend.lastFrame.split('\n').findIndex((r) => r.includes('36 tools:'));
  ui.backend.mouse('down', 12, summary);
  ui.backend.mouse('up', 12, summary);
  await settle(8);
  const trail = rowsMatching(ui, /▸ (datetime|config_schema)/);
  // Twelve lines of trail and one that says what is above them — not thirty-six.
  expect(trail).toHaveLength(12);
  expect(ui.backend.lastFrame).toContain('… 12 earlier calls');
  ui.app.unmount();
});

test('the line that stands for the earlier calls opens them', async () => {
  const model = new ScriptedModel();
  model.script(many(), [{ text: 'Done at last.' }]);
  const ui = await bootApp(model, 110, 60);
  await ui.press('F');
  await ui.type('do a lot');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Done at last.'));
  await settle(8);
  const summary = ui.backend.lastFrame.split('\n').findIndex((r) => r.includes('36 tools:'));
  ui.backend.mouse('down', 12, summary);
  ui.backend.mouse('up', 12, summary);
  await settle(8);
  const at = ui.backend.lastFrame.split('\n').findIndex((r) => r.includes('earlier calls'));
  expect(at).toBeGreaterThan(-1);
  ui.backend.mouse('down', 12, at);
  ui.backend.mouse('up', 12, at);
  await settle(8);
  expect(ui.backend.lastFrame).not.toContain('earlier calls');
  expect(rowsMatching(ui, /▸ (datetime|config_schema)/).length).toBeGreaterThan(12);
  // The run of thirteen calls of one tool is ONE line with its count — a different
  // argument is not a different line, and the arguments are in the log.
  expect(ui.backend.lastFrame).toMatch(/▸ datetime ×13 → ok/);
  ui.app.unmount();
});

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
  expect(ui.backend.lastFrame).toContain('3 tools: datetime ×2, config_schema');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle(8);
  // Three calls, three lines, each with its arguments — nothing is condensed away and
  // nothing is capped.
  expect(rowsMatching(ui, /▸ (datetime|config_schema)/)).toHaveLength(3);
  expect(ui.backend.lastFrame).not.toContain('earlier calls');
  // Each line is a call of its own with its arguments — nothing is condensed away.
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
  // Three of a kind on one line — and the reason, which is how a person knows why the
  // answer is thin. The group shares its outcome, so one reason stands for all of it.
  const line = rowsMatching(ui, /▸ no_such_tool/)[0] ?? '';
  expect(line).toContain('×3 → error');
  expect(line).toMatch(/— .*Unknown tool/i);
  ui.app.unmount();
});

test('a turn that runs out of rounds says so where the answer would be, in the warn colour', async () => {
  const model = new ScriptedModel();
  // Every round carries a tool call, so the loop never reaches an answer.
  model.script(...Array.from({ length: 70 }, () => [{ tool: 'datetime', args: {} }]));
  const ui = await bootApp(model, 110, 30);
  await ui.press('F');
  await ui.type('go round for ever');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('stopped after'), 900);
  await settle(8);
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('stopped after 64 rounds — no answer; say "continue" to carry on');
  // In the conversation, not on the dim hint line a wall of grey used to hide.
  expect(frame).not.toContain('ran out of steps');
  const y = frame.split('\n').findIndex((r) => r.includes('stopped after 64 rounds'));
  const x = Array.from(frame.split('\n')[y]!.slice(0, frame.split('\n')[y]!.indexOf('stopped'))).length;
  const cell = (ui.backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { fg?: string; dim?: boolean } } } }).lastBuffer.get(x, y);
  expect(cell.style.fg).toBe('yellow'); // the chat's warn colour
  expect(cell.style.dim).toBeFalsy();
  ui.app.unmount();
});
