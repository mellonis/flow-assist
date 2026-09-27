// What a compaction asks for and what it accepts back (src/assistant/compaction.ts).
import { expect, test } from 'bun:test';
import {
  HANDOFF_SECTIONS, SHORT_CHARS, autoCompactLimits, compactionInstruction, overThreshold, retryNote, summaryProblem,
} from '../compaction.js';
import { hasToolMarkup, markupToolNames, stripToolMarkup } from '../tool-markup.js';

const handoff = (extra = '') => [
  '## Goal', 'Port the engine to the new toolchain.',
  '## Done', '- commit a1b2c3d "engine: moves" — src/engine.pm; `pmt build` works.',
  '## In progress', 'Castling. Next step: run `pmt test castling`.',
  '## Open decisions', 'none',
  '## Facts learned', '- `pmt` needs `--std 2`.',
  extra,
].join('\n');

test('the instruction names every section, and asks for no question and no pleasantries', () => {
  const text = compactionInstruction();
  for (const s of HANDOFF_SECTIONS) expect(text).toContain(`## ${s}`);
  expect(text).toMatch(/handoff/i);
  expect(text).toMatch(/no question/i);
  expect(text).toMatch(/carry forward/i);
});

test('a handoff with every section and a sensible size passes', () => {
  expect(summaryProblem(handoff(), 2_000)).toBeNull();
});

test('headings are found loosely: bold, a colon, another case', () => {
  const loose = '**Goal:** x\n**done**: y\nIN PROGRESS — z\nOpen questions: none\nFacts learned:\n- w';
  expect(summaryProblem(loose, 100)).toBeNull();
});

test('a summary without the sections is refused, naming the missing ones', () => {
  const p = summaryProblem('Отлично! Какой следующий шаг предпочитаете?', 100);
  expect(p).toMatch(/missing the sections/);
  expect(p).toContain('Goal');
  expect(p).toContain('Facts learned');
  const partial = summaryProblem('## Goal\nx\n## Done\ny', 100);
  expect(partial).not.toContain('Goal,');
  expect(partial).toContain('In progress');
});

test('short is under 1% of the compacted tokens AND under the character floor', () => {
  // ~60 tokens of summary for 125k compacted: 0.05% — and far under the floor.
  const small = handoff();
  expect(small.length).toBeLessThan(SHORT_CHARS);
  expect(summaryProblem(small, 125_000)).toMatch(/too short/);
  // The same text for 5k compacted is over 1%: fine.
  expect(summaryProblem(small, 5_000)).toBeNull();
  // Over the floor is never short, however much was compacted.
  const long = handoff('x'.repeat(SHORT_CHARS));
  expect(summaryProblem(long, 10_000_000)).toBeNull();
});

test('the retry note says what was wrong', () => {
  expect(retryNote('it is too short')).toContain('it is too short');
  expect(retryNote('x')).toMatch(/again/);
});

test('tool-call markup is detected and stripped, closed or cut off', () => {
  const dsml = 'Checking.\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="read_file">\n<｜DSML｜parameter name="path" string="true">a.ts</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>\nThen more.';
  expect(hasToolMarkup(dsml)).toBe(true);
  expect(stripToolMarkup(dsml)).toBe('Checking.\n\nThen more.');
  const tagged = 'a <tool_call>{"name":"x","arguments":{}}</tool_call> b';
  expect(stripToolMarkup(tagged)).toBe('a  b');
  const fc = 'x\n<function_calls>\n<invoke name="ls">\n<parameter name="p">.</parameter>\n</invoke>\n</function_calls>';
  expect(stripToolMarkup(fc)).toBe('x');
  const bare = 'y\n<invoke name="ls"><parameter name="p">.</parameter></invoke>\nz';
  expect(stripToolMarkup(bare)).toBe('y\n\nz');
  // Cut off mid-call: everything from the opening tag goes.
  expect(stripToolMarkup('keep\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="x">')).toBe('keep');
  // Stray tokens of the DSML family go too.
  expect(stripToolMarkup('p <｜tool▁calls▁begin｜> q')).toBe('p  q');
  expect(hasToolMarkup('plain text with <b>html</b> and a < b')).toBe(false);
  expect(stripToolMarkup('plain text with <b>html</b>')).toBe('plain text with <b>html</b>');
});

test('ai.autoCompact: on at 0.8 by default, the threshold held to 0.5–0.95', () => {
  expect(autoCompactLimits(undefined)).toEqual({ enabled: true, threshold: 0.8 });
  expect(autoCompactLimits({ autoCompact: { enabled: false } })).toEqual({ enabled: false, threshold: 0.8 });
  expect(autoCompactLimits({ autoCompact: { threshold: 0.2 } }).threshold).toBe(0.5);
  expect(autoCompactLimits({ autoCompact: { threshold: 1 } }).threshold).toBe(0.95);
  expect(autoCompactLimits({ autoCompact: { threshold: 'x' } }).threshold).toBe(0.8);
});

test('overThreshold compares the next request to the share of the window', () => {
  const on = { enabled: true, threshold: 0.8 };
  expect(overThreshold(81_000, 100_000, on)).toBe(true);
  expect(overThreshold(80_000, 100_000, on)).toBe(false);
  expect(overThreshold(99_000, 100_000, { ...on, enabled: false })).toBe(false);
});

test('the tools a markup block names are read from either family', () => {
  expect(markupToolNames('<｜DSML｜function_calls>\n<｜DSML｜invoke name="search_in_files">\n</｜DSML｜invoke>')).toEqual(['search_in_files']);
  expect(markupToolNames('<tool_call>{"name": "read_file", "arguments": {}}</tool_call>')).toEqual(['read_file']);
  expect(markupToolNames('<invoke name="a"></invoke><invoke name="b"></invoke>')).toEqual(['a', 'b']);
  expect(markupToolNames('no markup')).toEqual([]);
});

test('tags shown as code are not markup: an answer or a handoff about them stays whole', () => {
  const inline = 'The stripper handles `<tool_call>` and `<invoke name="x">` blocks, closed or not.';
  expect(hasToolMarkup(inline)).toBe(false);
  expect(stripToolMarkup(inline)).toBe(inline);
  const fenced = 'Example:\n```\n<function_calls>\n<invoke name="ls">\n```\nAnd after it, more.';
  expect(hasToolMarkup(fenced)).toBe(false);
  expect(stripToolMarkup(fenced)).toBe(fenced);
  expect(markupToolNames(fenced)).toEqual([]);
  // Real markup beside code still goes; the code stays.
  expect(stripToolMarkup('see `<tool_call>`\n<tool_call>{"name":"x"}</tool_call>')).toBe('see `<tool_call>`');
});

test('the instruction asks for a length in proportion to what is compacted', () => {
  expect(compactionInstruction(200_000)).toMatch(/at least about [\d,]+ words/);
  const words = (t: number) => Number(/at least about ([\d,]+) words/.exec(compactionInstruction(t))![1]!.replace(/,/g, ''));
  expect(words(200_000)).toBeGreaterThan(words(20_000));
  expect(words(1_000)).toBeGreaterThanOrEqual(150); // a floor for a small conversation
});
