// How full the model's context is: the arithmetic, and what the chat shows of it.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  await ui.press('F');
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
  await ui.press('F');
  await ui.type('the first question');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('The first answer.');

  await ui.type('/compact');
  await ui.press('return');
  await settle(20);
  // The conversation is still on screen — it used to be wiped down to the last message.
  expect(ui.backend.lastFrame).toContain('the first question');
  expect(ui.backend.lastFrame).toContain('The first answer.');
  // One separator row saying how big the model's view was and is now; the summary is
  // folded under it until a click or the key opens it.
  const separator = ui.backend.lastFrame.split('\n').filter((r) => r.includes('── compacted'));
  expect(separator).toHaveLength(1);
  expect(separator[0]).toMatch(/── compacted · ~[\d.k]+ → ~[\d.k]+ tokens ── ▸ summary/);
  expect(ui.backend.lastFrame).not.toContain('SUMMARY: they greeted each other.');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).toContain('SUMMARY: they greeted each other.');
  expect(ui.backend.lastFrame).toContain('▾ summary');
  ui.backend.press({ name: 'o', ctrl: true });
  await settle();
  expect(ui.backend.lastFrame).not.toContain('SUMMARY: they greeted each other.');
  // A click on the separator opens that fold alone, and a second click closes it.
  const y = ui.backend.lastFrame.split('\n').findIndex((r) => r.includes('── compacted'));
  const x = ui.backend.lastFrame.split('\n')[y]!.indexOf('compacted');
  const click = async () => { ui.backend.mouse('down', x, y); ui.backend.mouse('up', x, y); await settle(6); };
  await click();
  expect(ui.backend.lastFrame).toContain('SUMMARY: they greeted each other.');
  const y2 = ui.backend.lastFrame.split('\n').findIndex((r) => r.includes('── compacted'));
  ui.backend.mouse('down', x, y2); ui.backend.mouse('up', x, y2); await settle(6);
  expect(ui.backend.lastFrame).not.toContain('SUMMARY: they greeted each other.');

  // The model's next request carries the summary and NOT the old messages.
  await ui.type('the second question');
  await ui.press('return');
  const last = JSON.stringify(model.requests.at(-1));
  expect(last).toContain('SUMMARY: they greeted each other.');
  expect(last).not.toContain('the first question');
  expect(last).not.toContain('── compacted'); // the note is the person's, not the model's
  expect(ui.backend.lastFrame).toContain('The second answer.');
});

test('past 80% the figure is drawn as a warning', async () => {
  const model = new ScriptedModel();
  model.usage = { prompt_tokens: 85_000, completion_tokens: 0 };
  model.script([{ text: 'ok' }]);
  const ui = await bootApp(model, 110, 30, undefined, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', contextWindow: 100_000 } });
  await ui.press('F');
  await ui.type('hi');
  await ui.press('return');
  const row = ui.backend.lastFrame.split('\n').findIndex((r) => r.includes('ctx 85%'));
  expect(row).toBeGreaterThan(-1);
  const col = ui.backend.lastFrame.split('\n')[row]!.indexOf('ctx 85%');
  expect(((ui.backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { fg?: string } } } }).lastBuffer.get(col, row)).style.fg).toBe('yellow');
});

// Cache usage (AGENTS.md, "How full the context is, is shown"): the last request's
// `TokenUsage` may carry `cachedTokens` / `cacheWriteTokens` from either wire — never
// defaulted to 0, only shown when the provider really reported them. `/context` draws
// them as a `last request: …` line, and the session keeps them (session-wide `usage`
// and the turn's own message, `cached`) so a saved chat still says where its tokens went.
test('the cache line: an OpenAI-compatible server\'s prompt_tokens_details.cached_tokens, kept with the session and the turn\'s message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-cache-e2e-'));
  const model = new ScriptedModel();
  model.usage = { prompt_tokens: 3300, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 2840 } };
  model.script([{ text: 'hi there' }]);
  const ui = await bootApp(model, 110, 30, undefined, { sessions: { dir }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', contextWindow: 100_000 } });
  await ui.press('F');
  await ui.type('hi');
  await ui.press('return');
  await settle(20);
  await ui.type('/context');
  await ui.press('return');
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('last request: 3.3k prompt · 2.8k from cache');
  // OpenAI-compatible servers report no write figure — the part is left out, not 0.
  expect(frame).not.toContain('written to cache');

  // Closing the panel, then the chat, writes the session at once (no debounce wait).
  await ui.press('escape', 'escape', 'escape');
  const [file] = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, file!), 'utf8'));
  expect(saved.usage).toMatchObject({ promptTokens: 3300, completionTokens: 200, cachedTokens: 2840 });
  expect('cacheWriteTokens' in saved.usage).toBe(false);
  const answer = saved.messages.find((m: Record<string, unknown>) => m.role === 'assistant' && typeof m.content === 'string' && (m.content as string).includes('hi there'));
  expect(answer.cached).toBe(2840);
  ui.app.unmount();
});

test('the cache line: Anthropic\'s cache_read/cache_creation, kept with the session and the turn\'s message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-cache-e2e-'));
  const realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-scripted';
  try {
    const model = new ScriptedModel();
    model.wire = 'anthropic';
    model.anthropicUsage = { input_tokens: 260, output_tokens: 200, cache_creation_input_tokens: 1200, cache_read_input_tokens: 2840 };
    model.script([{ text: 'hi there' }]);
    const ui = await bootApp(model, 110, 30, undefined, {
      sessions: { dir },
      ai: { provider: 'anthropic', model: 'claude-sonnet-5', toolLoading: 'all', contextWindow: 100_000 },
    });
    await ui.press('F');
    await ui.type('hi');
    await ui.press('return');
    await settle(20);
    await ui.type('/context');
    await ui.press('return');
    const frame = ui.backend.lastFrame;
    // promptTokens = input + cache_creation + cache_read = 260 + 1200 + 2840 = 4300.
    expect(frame).toContain('last request: 4.3k prompt · 2.8k from cache · 1.2k written to cache');

    await ui.press('escape', 'escape', 'escape');
    const [file] = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, file!), 'utf8'));
    expect(saved.usage).toMatchObject({ promptTokens: 4300, completionTokens: 200, cachedTokens: 2840, cacheWriteTokens: 1200 });
    const answer = saved.messages.find((m: Record<string, unknown>) => m.role === 'assistant' && typeof m.content === 'string' && (m.content as string).includes('hi there'));
    expect(answer.cached).toBe(2840);
    ui.app.unmount();
  } finally {
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey;
  }
});

test('a provider that reports no cache figures at all: the line says so, plainly', async () => {
  const model = new ScriptedModel();
  model.usage = { prompt_tokens: 3300, completion_tokens: 200 }; // no prompt_tokens_details
  model.script([{ text: 'hi there' }]);
  const ui = await bootApp(model, 110, 30, undefined, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', contextWindow: 100_000 } });
  await ui.press('F');
  await ui.type('hi');
  await ui.press('return');
  await settle(20);
  await ui.type('/context');
  await ui.press('return');
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('last request: 3.3k prompt · the provider reports no cache figures');
  expect(frame).not.toContain('from cache');
  expect(frame).not.toContain('written to cache');
  ui.app.unmount();
});
