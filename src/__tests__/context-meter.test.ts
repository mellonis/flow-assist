// How full the model's context is: the arithmetic, and what the chat shows of it.
import { expect, test } from 'bun:test';
import { CELL_FREE, CELL_FULL, CELL_PART, contextBadge, contextGrid, contextHeading, contextLegend, estimateTokens, readContext } from '../assistant/context-meter.js';
import { ScriptedModel, bootApp, settle } from './helpers/scripted.js';

const parts = (over: Partial<Parameters<typeof readContext>[0]> = {}) => ({
  system: 'x'.repeat(4000), memory: '', plan: '', summary: '', tools: [], messages: [], ...over,
});

test('without a provider figure the reading is an estimate, and says so', () => {
  const r = readContext(parts(), 100_000);
  expect(r.measured).toBe(false);
  expect(r.used).toBe(estimateTokens('x'.repeat(4000)) + estimateTokens('[]') * 2);
  expect(contextBadge(r)).toBe('ctx ~1%');
  expect(contextHeading(r)).toContain('(estimated)');
});

test('a provider figure wins, and the parts are scaled to add up to it', () => {
  const r = readContext(parts({ messages: [{ role: 'user', content: 'y'.repeat(4000) }] }), 100_000, 50_000);
  expect(r.measured).toBe(true);
  expect(contextBadge(r)).toBe('ctx 50%');
  const sum = r.parts.reduce((n, p) => n + p.tokens, 0);
  expect(Math.abs(sum - 50_000)).toBeLessThan(r.parts.length + 1); // rounding only
  expect(contextHeading(r)).not.toContain('(estimated)');
});

test('the ratio is clamped, and empty parts are not listed', () => {
  const r = readContext(parts(), 1000, 5000);
  expect(r.ratio).toBe(1);
  expect(r.parts.map((p) => p.label)).not.toContain('memory');
  expect(contextHeading(r)).toContain('100%');
});

test('the grid: every part that exists gets a cell, a part-filled cell is drawn half, the rest is free', () => {
  // 100 cells over a 100k window — 1k a cell. Messages 40k, instructions 0.4k, scaled to a measured 50k.
  const r = readContext(parts({ system: 'x'.repeat(1600), messages: [{ role: 'user', content: 'y'.repeat(160_000) }] }), 100_000, 50_000);
  const cells = contextGrid(r);
  expect(cells).toHaveLength(100);
  const of = (label: string | null) => cells.filter((c) => c.label === label);
  expect(of('instructions').length).toBe(1); // under a cell, still shown
  expect(of('instructions')[0]!.glyph).toBe(CELL_PART);
  expect(of('messages').length).toBeGreaterThanOrEqual(49);
  expect(of('messages')[0]!.glyph).toBe(CELL_FULL);
  expect(of(null).every((c) => c.glyph === CELL_FREE)).toBe(true);
  expect(of(null).length).toBe(100 - cells.filter((c) => c.label).length);
  // The legend names every part and what is free.
  expect(contextLegend(r).map((l) => l.label)).toEqual(['instructions', 'tools', 'messages', null]);
});

test('a window that is full has no free cells, and never more cells than the field', () => {
  const r = readContext(parts({ messages: [{ role: 'user', content: 'y'.repeat(400_000) }] }), 10_000, 50_000);
  const cells = contextGrid(r);
  expect(cells).toHaveLength(100);
  expect(cells.some((c) => c.label === null)).toBe(false);
});

test('the chat shows the estimate first and the measured figure after an answer; /context opens a panel, not a message', async () => {
  const model = new ScriptedModel();
  model.usage = { prompt_tokens: 58_000, completion_tokens: 2_000 };
  model.script([{ text: 'hello' }]);
  const ui = await bootApp(model, 110, 30, undefined, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', contextWindow: 100_000 } });
  await ui.press('A');
  expect(ui.backend.lastFrame).toMatch(/ctx ~\d+%/);

  await ui.type('hi');
  await ui.press('return');
  // The request asked for usage, and the figure on the line is now the provider's.
  expect((model.requests[0] as { stream_options?: { include_usage?: boolean } }).stream_options?.include_usage).toBe(true);
  expect(ui.backend.lastFrame).toContain('ctx 60%');

  const sent = model.requests.length;
  await ui.type('/context');
  await ui.press('return');
  const frame = ui.backend.lastFrame;
  expect(frame).toMatch(/Context\s+60% — 60k of 100k tokens/);
  // A field of cells beside a legend: 60 of 100 cells taken, the rest free.
  expect((frame.match(/[⛁⛀]/g) ?? []).length).toBeGreaterThanOrEqual(60 + 4); // + the legend's own marks
  expect((frame.match(/⛶/g) ?? []).length).toBeGreaterThanOrEqual(38);
  expect(frame).toMatch(/instructions\s+[\d.k]+\s+\d+%/);
  expect(frame).toMatch(/free\s+40k\s+40%/);
  // Both keys that close it are named — a key acts where it is shown.
  expect(frame).toContain('Esc / ⏎ close');
  // The panel stands where the field was, and holds the keys: typing goes nowhere.
  expect(frame).not.toContain('new line'); // the field's own hint is gone with the field
  await ui.type('x');
  expect(ui.backend.lastFrame).toMatch(/Context\s+60%/);
  // Esc puts it away and does NOT arm the chat's own «Esc again to exit».
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toMatch(/Context\s+60%/);
  expect(ui.backend.lastFrame).not.toContain('again to exit');
  expect(ui.backend.lastFrame).toContain('hello'); // the chat is still here
  // Nothing was sent, and nothing joined the conversation.
  expect(model.requests.length).toBe(sent);
  model.script([{ text: 'again' }]);
  await ui.type('more');
  await ui.press('return');
  expect(JSON.stringify(model.requests.at(-1))).not.toContain('of 100k tokens');
});

test('/compact shrinks what the model sees and leaves the screen alone', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'The first answer.' }], [{ text: 'SUMMARY: they greeted each other.' }], [{ text: 'The second answer.' }]);
  const ui = await bootApp(model, 110, 30);
  await ui.press('A');
  await ui.type('the first question');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('The first answer.');

  await ui.type('/compact');
  await ui.press('return');
  await settle(20);
  // The conversation is still on screen — it used to be wiped down to the last message.
  expect(ui.backend.lastFrame).toContain('the first question');
  expect(ui.backend.lastFrame).toContain('The first answer.');
  expect(ui.backend.lastFrame).toContain('compacted');
  expect(ui.backend.lastFrame).toContain('SUMMARY: they greeted each other.');

  // The model's next request carries the summary and NOT the old messages.
  await ui.type('the second question');
  await ui.press('return');
  const last = JSON.stringify(model.requests.at(-1));
  expect(last).toContain('SUMMARY: they greeted each other.');
  expect(last).not.toContain('the first question');
  expect(last).not.toContain('── compacted ──'); // the note is the person's, not the model's
  expect(ui.backend.lastFrame).toContain('The second answer.');
});

test('past 80% the figure is drawn as a warning', async () => {
  const model = new ScriptedModel();
  model.usage = { prompt_tokens: 85_000, completion_tokens: 0 };
  model.script([{ text: 'ok' }]);
  const ui = await bootApp(model, 110, 30, undefined, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', contextWindow: 100_000 } });
  await ui.press('A');
  await ui.type('hi');
  await ui.press('return');
  const row = ui.backend.lastFrame.split('\n').findIndex((r) => r.includes('ctx 85%'));
  expect(row).toBeGreaterThan(-1);
  const col = ui.backend.lastFrame.split('\n')[row]!.indexOf('ctx 85%');
  expect(((ui.backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { fg?: string } } } }).lastBuffer.get(col, row)).style.fg).toBe('yellow');
});
