import { expect, test } from 'bun:test';
import {
  TOOL_RESULT_MAX_CHARS_CEILING, TOOL_RESULT_MAX_CHARS_DEFAULT,
  capToolResult, resolveToolResultCap, toolResultCapFromConfig, wasCut,
} from '../tool-result-cap';

test('a short result is untouched', () => {
  expect(capToolResult('hello', 40_000)).toBe('hello');
  expect(capToolResult('x'.repeat(100), 100)).toBe('x'.repeat(100));
});

test('a long result is cut to the head and a short tail, with a note naming the total', () => {
  const text = 'H'.repeat(9000) + 'T'.repeat(1000); // 10000 chars total
  const cut = capToolResult(text, 1000);
  const note = '\n… [cut: 10000 characters in all — ask the tool for less: filters, a limit, one item]\n';
  expect(cut).toContain(note);
  // Head kept (90% of the cap), tail kept (the rest), nothing between but the note.
  expect(cut).toBe('H'.repeat(900) + note + 'T'.repeat(100));
  // At most the cap PLUS the note — the note itself is not squeezed into the cap.
  expect(cut.length).toBe(1000 + note.length);
});

test('a non-positive or missing cap leaves the text alone', () => {
  const text = 'x'.repeat(50);
  expect(capToolResult(text, 0)).toBe(text);
  expect(capToolResult(text, -1)).toBe(text);
  expect(capToolResult(text, undefined as unknown as number)).toBe(text);
});

test('the config default, unset or bad, falls back to TOOL_RESULT_MAX_CHARS_DEFAULT', () => {
  expect(toolResultCapFromConfig(undefined)).toBe(TOOL_RESULT_MAX_CHARS_DEFAULT);
  expect(toolResultCapFromConfig({})).toBe(TOOL_RESULT_MAX_CHARS_DEFAULT);
  expect(toolResultCapFromConfig({ toolResultMaxChars: 0 })).toBe(TOOL_RESULT_MAX_CHARS_DEFAULT);
  expect(toolResultCapFromConfig({ toolResultMaxChars: -5 })).toBe(TOOL_RESULT_MAX_CHARS_DEFAULT);
  expect(toolResultCapFromConfig({ toolResultMaxChars: 'lots' })).toBe(TOOL_RESULT_MAX_CHARS_DEFAULT);
  expect(toolResultCapFromConfig({ toolResultMaxChars: 80_000 })).toBe(80_000);
});

test('a per-tool cap overrides the default, clamped to the hard ceiling', () => {
  expect(resolveToolResultCap(40_000, undefined)).toBe(40_000);
  expect(resolveToolResultCap(40_000, 0)).toBe(40_000); // not a valid override — the default stands
  expect(resolveToolResultCap(40_000, 100_000)).toBe(100_000);
  expect(resolveToolResultCap(40_000, TOOL_RESULT_MAX_CHARS_CEILING + 50_000)).toBe(TOOL_RESULT_MAX_CHARS_CEILING);
});

test('wasCut knows the note capToolResult puts where it cut, and nothing else', () => {
  expect(wasCut(capToolResult('x'.repeat(1000), 100))).toBe(true);
  expect(wasCut(capToolResult('short', 100))).toBe(false);
  expect(wasCut('… [cut: characters]')).toBe(false);
});
