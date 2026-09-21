// How full the model's context is: the arithmetic, and what the chat shows of it.
import { expect, test } from 'bun:test';
import { contextBadge, contextNote, estimateTokens, readContext } from '../assistant/context-meter.js';
import { ScriptedModel, bootApp } from './helpers/scripted.js';

const parts = (over: Partial<Parameters<typeof readContext>[0]> = {}) => ({
  system: 'x'.repeat(4000), memory: '', plan: '', summary: '', tools: [], messages: [], ...over,
});

test('without a provider figure the reading is an estimate, and says so', () => {
  const r = readContext(parts(), 100_000);
  expect(r.measured).toBe(false);
  expect(r.used).toBe(estimateTokens('x'.repeat(4000)) + estimateTokens('[]') * 2);
  expect(contextBadge(r)).toBe('ctx ~1%');
  expect(contextNote(r)).toContain('(estimated)');
});

test('a provider figure wins, and the parts are scaled to add up to it', () => {
  const r = readContext(parts({ messages: [{ role: 'user', content: 'y'.repeat(4000) }] }), 100_000, 50_000);
  expect(r.measured).toBe(true);
  expect(contextBadge(r)).toBe('ctx 50%');
  const sum = r.parts.reduce((n, p) => n + p.tokens, 0);
  expect(Math.abs(sum - 50_000)).toBeLessThan(r.parts.length + 1); // rounding only
  expect(contextNote(r)).not.toContain('(estimated)');
});

test('the ratio is clamped, and empty parts are not listed', () => {
  const r = readContext(parts(), 1000, 5000);
  expect(r.ratio).toBe(1);
  expect(r.parts.map((p) => p.label)).not.toContain('memory');
  expect(contextNote(r)).toContain('100%');
});

test('the chat shows the estimate first and the measured figure after an answer; /context breaks it down', async () => {
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
  expect(ui.backend.lastFrame).toMatch(/Context\s+█+░+\s+60% — 60k of 100k tokens/);
  expect(ui.backend.lastFrame).toMatch(/instructions/);
  expect(ui.backend.lastFrame).toMatch(/free\s+40k\s+40%/);
  // A note for the person: nothing was sent, and the next request does not carry it.
  expect(model.requests.length).toBe(sent);
  model.script([{ text: 'again' }]);
  await ui.type('more');
  await ui.press('return');
  expect(JSON.stringify(model.requests.at(-1))).not.toContain('of 100k tokens');
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
