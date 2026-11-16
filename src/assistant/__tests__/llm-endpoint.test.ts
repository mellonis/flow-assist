// The answer's ceiling, resolved in one place (../llm-endpoint.ts): the person's
// ai.maxTokens over everything, else the model's own catalogue entry, else the room its
// window leaves after what the conversation last sent. Pure: config in, a number out.
import { expect, test } from 'bun:test';
import { answerCeiling, llmConfigNotes } from '../llm-endpoint';

test("answerCeiling prefers ai.maxTokens over the model's catalogue entry", () => {
  const ai = { maxTokens: 7000, models: { m: { contextWindow: 262_144, maxTokens: 9000 } } };
  expect(answerCeiling(ai, { model: 'm' })).toBe(7000);
});

test("answerCeiling takes the model's own catalogue entry over the derived default", () => {
  const ai = { model: 'm', models: { m: { contextWindow: 262_144, maxTokens: 9000 } } };
  expect(answerCeiling(ai, { model: 'm' })).toBe(9000);
  // The model the turn runs is the one asked about; ai.model answers when none is named.
  expect(answerCeiling(ai)).toBe(9000);
  // Another model has no entry of its own, so the window's room is derived — 200k here,
  // nothing sent yet, and the cap is what holds.
  expect(answerCeiling(ai, { model: 'other' })).toBe(32_000);
});

test('answerCeiling derives from the window room', () => {
  const ai = { models: { m: { contextWindow: 100_000 } } };
  // floor(100000 * 0.99) − 50000 − 1024 = 47976, over the cap.
  expect(answerCeiling(ai, { model: 'm', inputTokens: 50_000 })).toBe(32_000);
  // floor(100000 * 0.99) − 97000 − 1024 = 976, under the floor.
  expect(answerCeiling(ai, { model: 'm', inputTokens: 97_000 })).toBe(1_024);
  // No ai.models and no ai.contextWindow: modelWindow's own 200000.
  expect(answerCeiling({}, {})).toBe(32_000);
});

test('llmConfigNotes names the ceiling it resolved', () => {
  // ai.maxTokens unset: the ceiling is the derived 32000, and that is the number said.
  const notes = llmConfigNotes({ provider: 'anthropic', thinking: { budgetTokens: 40_000 } });
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatch(/^ai\.thinking\.budgetTokens 40000 does not fit under the answer ceiling of 32000 with room for the answer — sent as 30976; raise ai\.maxTokens/);
  expect(notes[0]).not.toContain('8192');
});

test('answerCeiling reads ai.model when the call names no model', () => {
  // Rule 3 (the window's room) then measures the model the config says the chat runs —
  // floor(10000 × 0.99) − 0 − 1024.
  expect(answerCeiling({ model: 'm', models: { m: { contextWindow: 10_000 } } })).toBe(8_876);
});

test('answerCeiling takes an ai that is not an object as an empty one', () => {
  expect(answerCeiling(null, {})).toBe(32_000);
  expect(answerCeiling('anthropic', { model: 'm' })).toBe(32_000);
  expect(answerCeiling(undefined)).toBe(32_000);
});

test('answerCeiling counts a negative inputTokens as room, under the cap', () => {
  // Nothing clamps `inputTokens`: a negative one only widens the room (and the cap or the
  // floor still holds). A conversation never reports one; the resolved number is pinned.
  const ai = { models: { m: { contextWindow: 20_000 } } };
  expect(answerCeiling(ai, { model: 'm' })).toBe(18_776);
  expect(answerCeiling(ai, { model: 'm', inputTokens: -10_000 })).toBe(28_776);
});
