// `ai.autoCompact`: before a request that would pass the threshold of the window, the
// conversation is compacted first — the same handoff and the same row as /compact,
// marked `auto` — at a request boundary, so a call is never parted from its result.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, handoff, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'sk-ant-scripted'; });
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey;
});

const WINDOW = 20_000;
// A handoff long enough for what these tests compact (a short one is asked for again).
const long = (mark: string) => handoff(`${mark} ${'f'.repeat(1500)}`);
type UI = Awaited<ReturnType<typeof bootApp>>;
const body = (model: ScriptedModel, i: number) => JSON.stringify(model.requests[i]);
const streamed = (model: ScriptedModel, i: number) => (model.requests[i] as { stream?: boolean }).stream === true;
const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

async function boot(model: ScriptedModel, wire: 'openai' | 'anthropic', autoCompact?: Record<string, unknown>) {
  model.wire = wire;
  const ai = wire === 'anthropic'
    ? { provider: 'anthropic', model: 'claude-sonnet-5', toolLoading: 'all', contextWindow: WINDOW }
    : { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', contextWindow: WINDOW };
  const ui = await bootApp(model, 110, 30, undefined, { ai: { ...ai, ...(autoCompact ? { autoCompact } : {}) } });
  await ui.press('F');
  return ui;
}
async function ask(ui: UI, text: string) {
  await ui.type(text);
  await ui.press('return');
  await settle(20);
}
// The provider reports what a request really weighs: its body in tokens as the prompt,
// and `completion` for the answer — the anthropic wire always reports usage.
function measure(model: ScriptedModel, completion: (i: number) => number) {
  const scripted = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const i = model.requests.length;
    const prompt = Math.ceil(String(init.body).length / 4);
    model.usage = { prompt_tokens: prompt, completion_tokens: completion(i) };
    model.anthropicUsage = { input_tokens: prompt, output_tokens: completion(i) };
    return scripted(url as string, init);
  }) as typeof fetch;
}

for (const wire of ['openai', 'anthropic'] as const) {
  test(`${wire}: a turn that crosses the threshold between rounds compacts before its next request, and that request fits`, async () => {
    const model = new ScriptedModel();
    model.script([{ text: 'short' }]);
    const ui = await boot(model, wire);
    const narration = `Checking the clock. ${'n'.repeat(Math.ceil(WINDOW * 0.2 * 4))}`;
    measure(model, (i) => (i === 2 ? Math.ceil(narration.length / 4) : 5));
    await ask(ui, 'first');
    const base = Math.ceil(body(model, 0).length / 4);
    expect(base).toBeLessThan(WINDOW * 0.4);
    // A long answer: the conversation now weighs about 0.65 of the window.
    const big = `BIG-ANSWER ${'b'.repeat(Math.ceil((WINDOW * 0.65 - base) * 4))}`;
    model.script([{ text: big }]);
    await ask(ui, 'tell me everything');
    expect(ui.backend.lastFrame).not.toContain('compacted');
    // The next question starts under the threshold; its first round writes a lot and
    // calls a tool, and the request after it would pass 0.8.
    model.script([{ text: narration, tool: 'datetime', args: {} }], [{ text: long('AUTO-HANDOFF') }], [{ text: 'It is noon.' }]);
    await ask(ui, 'what time is it?');
    await settleUntil(() => model.requests.length >= 5 && ui.backend.lastFrame.includes('It is noon.'));
    expect(model.requests).toHaveLength(5);
    expect(streamed(model, 2)).toBe(true);
    // Request 3 is the compaction: the call AND its result are in it, as text.
    expect(streamed(model, 3)).toBe(false);
    expect(body(model, 3)).toContain('[called datetime');
    expect(body(model, 3)).toContain('tool result:');
    expect(body(model, 3)).toContain('BIG-ANSWER');
    // The request after it fits, carries the handoff and the question — and nothing of
    // the old conversation, no call without its result (the anthropic double refuses one).
    expect(streamed(model, 4)).toBe(true);
    expect(body(model, 4).length / 4).toBeLessThan(WINDOW * 0.8);
    expect(body(model, 4)).toContain('AUTO-HANDOFF');
    expect(body(model, 4)).toContain('what time is it?');
    expect(body(model, 4)).toContain('continue from its next step');
    expect(body(model, 4)).not.toContain('BIG-ANSWER');
    expect(body(model, 4)).not.toContain('Checking the clock');
    const row = ui.backend.lastFrame.split('\n').filter((r) => r.includes('── compacted'));
    expect(row).toHaveLength(1);
    expect(row[0]).toMatch(/── compacted · auto · ~[\d.k]+ → ~[\d.k]+ tokens ──/);
    expect(ui.backend.lastFrame).toContain('It is noon.');

    // The conversation goes on from there: the question, its answer, the next one.
    model.script([{ text: 'Later.' }]);
    await ask(ui, 'and now?');
    const next = model.requests.at(-1) as { messages: { role: string; content: unknown }[] };
    const text = JSON.stringify(next.messages);
    expect(text).toContain('what time is it?');
    expect(text).toContain('It is noon.');
    expect(text).toContain('and now?');
    expect(text).not.toContain('BIG-ANSWER');
  });
}

test('a conversation already over the threshold is compacted before the first request of the next turn', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'short' }]);
  const ui = await boot(model, 'openai');
  await ask(ui, 'first');
  const base = Math.ceil(body(model, 0).length / 4);
  model.script([{ text: `BIG-ANSWER ${'b'.repeat(Math.ceil((WINDOW * 0.85 - base) * 4))}` }]);
  await ask(ui, 'tell me everything');
  model.script([{ text: long('BEFORE-HANDOFF') }], [{ text: 'Sure.' }]);
  await ask(ui, 'the next question');
  await settleUntil(() => ui.backend.lastFrame.includes('Sure.'));
  expect(model.requests).toHaveLength(4);
  expect(streamed(model, 2)).toBe(false);
  expect(streamed(model, 3)).toBe(true);
  expect(body(model, 3)).toContain('BEFORE-HANDOFF');
  expect(body(model, 3)).toContain('the next question');
  expect(body(model, 3)).not.toContain('continue from its next step'); // nothing of this turn was folded
  expect(body(model, 3)).not.toContain('BIG-ANSWER');
  expect(ui.backend.lastFrame).toMatch(/── compacted · auto/);
});

test('autoCompact.enabled false never compacts by itself', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'short' }]);
  const ui = await boot(model, 'openai', { enabled: false });
  await ask(ui, 'first');
  const base = Math.ceil(body(model, 0).length / 4);
  model.script([{ text: `BIG-ANSWER ${'b'.repeat(Math.ceil((WINDOW * 0.85 - base) * 4))}` }]);
  await ask(ui, 'tell me everything');
  model.script([{ text: 'Sure.' }]);
  await ask(ui, 'the next question');
  await settleUntil(() => ui.backend.lastFrame.includes('Sure.'));
  expect(model.requests).toHaveLength(3);
  expect(model.requests.every((_, i) => streamed(model, i))).toBe(true);
  expect(body(model, 2)).toContain('BIG-ANSWER');
  expect(ui.backend.lastFrame).not.toContain('compacted');
});
