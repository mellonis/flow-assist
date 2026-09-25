// The host's own renderer: a command, folded to one line, opened to its last lines.
import { expect, test } from 'bun:test';
import { capConsoleData, capConsoleText, consoleTail, renderConsole, type ConsoleData } from '../console-view';
import { VIEW_CAPS, type ViewRenderCtx } from '../views';

const base: ViewRenderCtx = { width: 60, folded: true, live: false, failed: false, elapsedMs: 0, lines: 3, moreKey: '^o' };
const d = (over: Partial<ConsoleData> = {}): ConsoleData => ({ command: 'bun test', cwd: '~/app', text: '', exitCode: 0, ms: 4200, status: 'exit 0', ...over });
const plain = (spans: { text: string }[]) => spans.map((s) => s.text).join('');

test('the tail says how it ended, not a code to decode', () => {
  expect(plain(consoleTail(d(), base))).toBe('✓ 4.2 s');
  expect(consoleTail(d(), base)[0]!.color).toBe('ok');
  expect(plain(consoleTail(d({ exitCode: 1, status: 'exit 1' }), base))).toBe('✗ exit 1 · 4.2 s');
  expect(consoleTail(d({ exitCode: 1, status: 'exit 1' }), base)[0]!.color).toBe('warn');
  expect(plain(consoleTail(d({ exitCode: null, status: 'stopped (Esc)' }), base))).toBe('stopped · 4.2 s');
  expect(plain(consoleTail(d({ exitCode: null, status: 'timed out after 120 s', ms: 120000 }), base))).toBe('timed out · 120.0 s');
  expect(plain(consoleTail(d(), { ...base, failed: true }))).toBe('✗ failed');
});

test('while it runs the tail is its clock in whole seconds', () => {
  expect(plain(consoleTail(d({ exitCode: undefined, ms: undefined, status: undefined }), { ...base, live: true, elapsedMs: 12_900 }))).toBe('12 s');
});

test('folded, a command is one line; the $ is the gutter\'s, not the renderer\'s', () => {
  expect(renderConsole(d({ text: 'a\nb\nc' }), base).map(plain)).toEqual(['bun test · ✓ 4.2 s']);
});

test('folded, a command longer than a click shows says how many lines it holds', () => {
  expect(renderConsole(d({ text: 'a\nb\nc\nd' }), base).map(plain)).toEqual(['bun test · ✓ 4.2 s · 4 lines']);
  expect(renderConsole(d({ text: 'a\nb\nc' }), base).map(plain)).toEqual(['bun test · ✓ 4.2 s']);
});

test('a person\'s own command also says where it ran', () => {
  expect(renderConsole(d({ showCwd: true }), base).map(plain)).toEqual(['bun test · ✓ 4.2 s · ~/app']);
});

test('a cd inside the command is an arrow to where it left the directory', () => {
  expect(plain(consoleTail(d({ showCwd: true, movedTo: '~/app/sub' }), base))).toBe('✓ 4.2 s · ~/app → ~/app/sub');
  // Unchanged (or not set at all): no arrow.
  expect(plain(consoleTail(d({ showCwd: true, movedTo: '~/app' }), base))).toBe('✓ 4.2 s · ~/app');
  expect(plain(consoleTail(d({ showCwd: true }), base))).toBe('✓ 4.2 s · ~/app');
  // Never drawn without showCwd — a tool's run_command view never sets it.
  expect(plain(consoleTail(d({ movedTo: '~/app/sub' }), base))).toBe('✓ 4.2 s');
});

test('a cd refused outside the roots says so, and stays fixed wording whatever the note holds', () => {
  expect(plain(consoleTail(d({ showCwd: true, note: 'cd led outside the roots — staying in /tmp/x' }), base)))
    .toBe('✓ 4.2 s · ~/app · cd led outside the roots — stayed');
  // Never drawn without showCwd.
  expect(plain(consoleTail(d({ note: 'cd led outside the roots — staying in /tmp/x' }), base))).toBe('✓ 4.2 s');
});

test('open, the last lines stand under a bar that a drag does not copy', () => {
  const lines = renderConsole(d({ text: '1\n2\n3\n4\n5' }), { ...base, folded: false });
  expect(lines.map(plain)).toEqual(['bun test', '│ … 2 lines cut · ^o for all', '│ 3', '│ 4', '│ 5', '✓ 4.2 s']);
  expect(lines[2]![0]).toEqual({ text: '│ ', chrome: true, dim: true });
});

test('open with nothing cut, and open with no output', () => {
  expect(renderConsole(d({ text: 'x' }), { ...base, folded: false }).map(plain)).toEqual(['bun test', '│ x', '✓ 4.2 s']);
  expect(renderConsole(d({ text: '' }), { ...base, folded: false }).map(plain)).toEqual(['bun test', '✓ 4.2 s']);
});

test('what a console view keeps is the capped tail', () => {
  const many = Array.from({ length: VIEW_CAPS.lines + 5 }, (_, i) => `l${i}`).join('\n');
  const kept = capConsoleText(many).split('\n');
  expect(kept).toHaveLength(VIEW_CAPS.lines);
  expect(kept.at(-1)).toBe(`l${VIEW_CAPS.lines + 4}`);
  expect(capConsoleText('x'.repeat(VIEW_CAPS.lineChars + 9))).toHaveLength(VIEW_CAPS.lineChars + 1);
});

// A view's data is capped where it is COLLECTED, whichever path hands it over — a
// live view's first state, an update, or the old one-argument reportView — so a
// session file stays bounded whichever way the data arrived.
test('capConsoleData caps a console view like a confirmed run_command does', () => {
  const long = Array.from({ length: VIEW_CAPS.lines + 5 }, (_, i) => `l${i}`).join('\n');
  const capped = capConsoleData({ command: 'c'.repeat(VIEW_CAPS.command + 50), text: long, exitCode: 0, ms: 1, cwd: '~', weird: 'nope' } as unknown);
  expect(capped.command).toHaveLength(VIEW_CAPS.command + 1);
  expect(capped.text.split('\n')).toHaveLength(VIEW_CAPS.lines);
  expect((capped as Record<string, unknown>).weird).toBeUndefined();
});

test('capConsoleData caps movedTo and note the way it caps every other field', () => {
  const capped = capConsoleData({ command: 'cd sub', cwd: '~', movedTo: 'm'.repeat(VIEW_CAPS.command + 50), note: 'n'.repeat(200) } as unknown);
  expect(capped.movedTo).toHaveLength(VIEW_CAPS.command + 1);
  expect(capped.note).toHaveLength(81);
  // Absent stays absent — no field a session file has to carry for every command.
  expect(capConsoleData({ command: 'x', cwd: '~' }).movedTo).toBeUndefined();
  expect(capConsoleData({ command: 'x', cwd: '~' }).note).toBeUndefined();
});
