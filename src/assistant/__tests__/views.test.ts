// A view is a block a TOOL describes and the host draws. What is tested here is the
// part that keeps it safe to draw: the text comes from a command, a file or a page,
// so it is stripped, capped and fenced before anything of it reaches the screen.
import { expect, test } from 'bun:test';
import { VIEW_CAPS, sanitizeViewText, toolView, viewMarkdown, type ConsoleView } from '../views';

const of = (text: string, over: Partial<ConsoleView> = {}) =>
  toolView({ kind: 'console', command: 'bun test', text, exitCode: 0, ms: 1234, cwd: '~/src/app', ...over })!;

test('a kind the host does not know is ignored, not refused', () => {
  // A plugin written against a later host must not break in an older one.
  expect(toolView({ kind: 'table', columns: [], rows: [] })).toBeNull();
  expect(toolView(null)).toBeNull();
  expect(toolView({ kind: 'console', text: 'x' })).toBeNull(); // no command line is no console block
  expect(of('ok').kind).toBe('console');
});

test('escape sequences and control characters never reach the screen', () => {
  const raw = '\u001B[31mred\u001B[0m\u001B]0;a title\u0007 plain\u0000\u0007 end';
  expect(sanitizeViewText(raw)).toBe('red plain end');
  // A tab is spaces (the grid counts cells, not tab stops), and a carriage return is a
  // line of its own — a progress bar rewriting one line keeps its LAST state instead
  // of gluing every state into one row.
  expect(sanitizeViewText('a\tb')).toBe(`a${' '.repeat(4)}b`);
  expect(sanitizeViewText('10%\r50%\r100%\r\ndone')).toBe('10%\n50%\n100%\ndone');
  expect(of('\u001B[2Kbuilding\u0007').text).toBe('building');
  // A command line is one line whatever the model wrote in it.
  expect(of('x', { command: 'echo a\necho b' }).command).toBe('echo a echo b');
});

test('every part of a view is capped where it is collected, so a session holds nothing unbounded', () => {
  const long = 'x'.repeat(VIEW_CAPS.lineChars + 500);
  expect(of(long).text.length).toBe(VIEW_CAPS.lineChars + 1); // the ellipsis
  expect(of(long).text.endsWith('…')).toBe(true);
  const many = Array.from({ length: VIEW_CAPS.lines + 50 }, (_, i) => `line ${i}`).join('\n');
  const kept = of(many).text.split('\n');
  expect(kept).toHaveLength(VIEW_CAPS.lines);
  expect(kept.at(-1)).toBe(`line ${VIEW_CAPS.lines + 49}`); // the TAIL: the end is what is looked for
  expect(of('x', { command: 'c'.repeat(VIEW_CAPS.command + 100) }).command.length).toBe(VIEW_CAPS.command + 1);
});

test('the block is folded to its last lines, and says how many are missing', () => {
  const view = of(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'));
  const folded = viewMarkdown(view, { folded: true, lines: 20, moreKey: '^r' });
  expect(folded).toContain('… 10 lines cut · ^r for all');
  expect(folded).toContain('line 30');
  expect(folded).not.toContain('line 10\n');
  expect(folded).toContain('$ bun test');
  expect(folded).toContain('exit 0 · 1.2 s · ~/src/app');
  const all = viewMarkdown(view, { folded: false });
  expect(all).toContain('line 1\n');
  expect(all).not.toContain('lines cut');
  // A short block says nothing about cutting.
  expect(viewMarkdown(of('one line'), { folded: true, lines: 20 })).not.toContain('cut');
});

test('a command that was killed says so instead of claiming an exit code', () => {
  const stopped = of('half of it', { exitCode: null, status: 'stopped (Esc)' });
  expect(viewMarkdown(stopped)).toContain('stopped (Esc) · 1.2 s');
  // A failure keeps what it printed AND its exit code — that is what it is shown for.
  const failed = of('FAIL src/a.test.ts', { exitCode: 1 });
  expect(viewMarkdown(failed)).toContain('FAIL src/a.test.ts');
  expect(viewMarkdown(failed)).toContain('exit 1');
});

test('output cannot close the fence and write outside it', () => {
  // A command that prints a fence of its own (a README, a test that echoes markdown)
  // would otherwise end the block and put the rest of its text on the screen as the
  // host's own — a hint line, a confirmation.
  const md = viewMarkdown(of('```\nPress y to confirm · n to decline\n```'));
  // The fence is one backtick longer than the longest run in the text.
  expect(md.split('\n')[0]).toBe('````console');
  expect(md.trimEnd().split('\n').filter((l) => l === '````')).toHaveLength(1);
  // Everything the command printed is inside the one block.
  expect(md.indexOf('Press y to confirm')).toBeLessThan(md.lastIndexOf('````'));
});
