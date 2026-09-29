// The host's own renderer: a command, folded to one line, opened to its last lines.
import { expect, test } from 'bun:test';
import { capConsoleData, capConsoleText, consoleTail, renderConsole, type ConsoleData } from '../console-view';
import { frameView, VIEW_CAPS, type ViewRecord, type ViewRenderCtx } from '../views';

const base: ViewRenderCtx = { width: 60, folded: true, live: false, failed: false, elapsedMs: 0, lines: 3, moreKey: '^o' };
const d = (over: Partial<ConsoleData> = {}): ConsoleData => ({ command: 'bun test', cwd: '~/app', text: '', exitCode: 0, ms: 4200, status: 'exit 0', ...over });
const plain = (spans: { text: string }[]) => spans.map((s) => s.text).join('');

test('the tail says how it ended, not a code to decode', () => {
  expect(plain(consoleTail(d(), base))).toBe('✓ 4s');
  expect(consoleTail(d(), base)[0]!.color).toBe('ok');
  expect(plain(consoleTail(d({ exitCode: 1, status: 'exit 1' }), base))).toBe('✗ exit 1 · 4s');
  expect(consoleTail(d({ exitCode: 1, status: 'exit 1' }), base)[0]!.color).toBe('warn');
  expect(plain(consoleTail(d({ exitCode: null, status: 'stopped (Esc)' }), base))).toBe('stopped · 4s');
  expect(plain(consoleTail(d({ exitCode: null, status: 'timed out after 120 s', ms: 120000 }), base))).toBe('timed out · 2m 0s');
  expect(plain(consoleTail(d(), { ...base, failed: true }))).toBe('✗ failed');
});

test('while it runs the tail is its clock in whole seconds', () => {
  expect(plain(consoleTail(d({ exitCode: undefined, ms: undefined, status: undefined }), { ...base, live: true, elapsedMs: 12_900 }))).toBe('12s');
});

test('folded, a command is one line; the run mark is the gutter\'s, not the renderer\'s', () => {
  expect(renderConsole(d({ text: 'a\nb\nc' }), base).map(plain)).toEqual(['bun test · ✓ 4s']);
});

test('folded, a command longer than a click shows says how many lines it holds', () => {
  expect(renderConsole(d({ text: 'a\nb\nc\nd' }), base).map(plain)).toEqual(['bun test · ✓ 4s · 4 lines']);
  expect(renderConsole(d({ text: 'a\nb\nc' }), base).map(plain)).toEqual(['bun test · ✓ 4s']);
});

test('a view cut at collection remembers how much was printed, and its fold line says it holds the tail', () => {
  const printed = Array.from({ length: 300 }, (_, i) => String(i + 1)).join('\n');
  const once = capConsoleData({ command: 'seq 1 300', cwd: '~', text: printed, exitCode: 0, ms: 10 });
  expect(once.lines).toBe(300);
  expect(once.text.split('\n')).toHaveLength(VIEW_CAPS.lines);
  // Capped again — a saved session read back, the final update of a live view — the
  // count it was handed stands.
  expect(capConsoleData(once).lines).toBe(300);
  expect(renderConsole(once, base).map(plain)).toEqual(['seq 1 300 · ✓ <1s · last 200 of 300 lines']);
  // Nothing cut, nothing recorded.
  expect(capConsoleData({ command: 'x', cwd: '~', text: 'a\nb' }).lines).toBeUndefined();
});

test('a folded row at a narrow width cuts the command, never the duration and the outcome', () => {
  const rec: ViewRecord = { kind: 'console', data: d({ command: 'x'.repeat(300) }), phase: 'done', startedAt: 0 };
  const framed = frameView(rec, { console: renderConsole }, { ...base, width: 24 }, {});
  const text = framed.map((l) => l.spans.map((s) => s.text).join('')).join('\n');
  expect(text).toContain('✓ 4s');
  expect(text).toContain('…');
});

test('the opened block never cuts the command, however long — it wraps across its own rows', () => {
  const command = Array.from({ length: 2000 }, (_, i) => String(i % 10)).join('');
  const rec: ViewRecord = { kind: 'console', data: d({ command, text: '' }), phase: 'done', startedAt: 0 };
  const framed = frameView(rec, { console: renderConsole }, { ...base, width: 80, folded: false }, {});
  const rows = framed.map((l) => l.spans.map((s) => s.text).join(''));
  const tail = rows.pop(); // the outcome row, `✓ 4s`
  expect(tail).toBe('✓ 4s');
  expect(rows.join('')).toBe(command);
  expect(rows.some((r) => r.includes('…'))).toBe(false);
});

test('a command long enough to wrap past VIEW_CAPS.commandRows cuts to a dim note instead of pushing the output or the outcome out of the block', () => {
  const command = 'x'.repeat(10 * 1024);
  const output = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
  const rec: ViewRecord = { kind: 'console', data: d({ command, text: output }), phase: 'done', startedAt: 0 };
  const ctx: ViewRenderCtx = { width: 40, folded: false, live: false, failed: false, elapsedMs: 0, lines: VIEW_CAPS.lines, moreKey: '^o' };
  const framed = frameView(rec, { console: renderConsole }, ctx, {});
  const rows = framed.map((l) => l.spans.map((s) => s.text).join(''));
  // The command wraps to far more than VIEW_CAPS.commandRows rows at this width — it
  // is cut to a dim note rather than eating the row budget the output and the
  // outcome need.
  expect(rows.filter((r) => /^x+$/.test(r)).length).toBe(VIEW_CAPS.commandRows);
  expect(rows.some((r) => /… \d+ more lines? of the command/.test(r))).toBe(true);
  // The last line the run printed, and the outcome, both survive — as the block's
  // very last row.
  expect(rows).toContain('│ line 200');
  expect(rows.at(-1)).toBe('✓ 4s');
});

test('the same command survives the pager\'s own layout (blockRows), not just frameView directly', async () => {
  const { blockRows } = await import('../../views/modals.js');
  const command = 'x'.repeat(10 * 1024);
  const output = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
  const msg = { role: 'shell', content: '', views: [{ kind: 'console', data: d({ command, text: output }), phase: 'done', startedAt: 0 }] };
  const rows = blockRows([msg] as never, {
    wrap: 40, folds: { open: true, except: new Set() }, viewLines: VIEW_CAPS.lines, notes: 'step', detailsKey: '^o',
    renderers: { console: renderConsole }, now: 0, palette: {},
  }, '0:view:0').map((r) => (r.spans ?? []).map((s) => s.text).join(''));
  expect(rows).toContain('│ line 200');
  expect(rows.at(-1)).toBe('✓ 4s');
});

test('a person\'s own command also says where it ran', () => {
  expect(renderConsole(d({ showCwd: true }), base).map(plain)).toEqual(['bun test · ✓ 4s · ~/app']);
});

test('a cd inside the command is an arrow to where it left the directory', () => {
  expect(plain(consoleTail(d({ showCwd: true, movedTo: '~/app/sub' }), base))).toBe('✓ 4s · ~/app → ~/app/sub');
  // Unchanged (or not set at all): no arrow.
  expect(plain(consoleTail(d({ showCwd: true, movedTo: '~/app' }), base))).toBe('✓ 4s · ~/app');
  expect(plain(consoleTail(d({ showCwd: true }), base))).toBe('✓ 4s · ~/app');
  // Never drawn without showCwd — a tool's run_command view never sets it.
  expect(plain(consoleTail(d({ movedTo: '~/app/sub' }), base))).toBe('✓ 4s');
});

test('a cd refused outside the roots says so, and stays fixed wording whatever the note holds', () => {
  expect(plain(consoleTail(d({ showCwd: true, note: 'cd led outside the roots — staying in /tmp/x' }), base)))
    .toBe('✓ 4s · ~/app · cd led outside the roots — stayed');
  // Never drawn without showCwd.
  expect(plain(consoleTail(d({ note: 'cd led outside the roots — staying in /tmp/x' }), base))).toBe('✓ 4s');
});

test('open, the last lines stand under a bar that a drag does not copy', () => {
  const lines = renderConsole(d({ text: '1\n2\n3\n4\n5' }), { ...base, folded: false });
  expect(lines.map(plain)).toEqual(['bun test', '│ … 2 lines cut · ^o for all', '│ 3', '│ 4', '│ 5', '✓ 4s']);
  expect(lines[2]![0]).toEqual({ text: '│ ', chrome: true, dim: true });
});

test('open with nothing cut, and open with no output', () => {
  expect(renderConsole(d({ text: 'x' }), { ...base, folded: false }).map(plain)).toEqual(['bun test', '│ x', '✓ 4s']);
  expect(renderConsole(d({ text: '' }), { ...base, folded: false }).map(plain)).toEqual(['bun test', '✓ 4s']);
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

test('capConsoleData keeps a multi-line command\'s own line breaks — every other field is flattened to one line', () => {
  const capped = capConsoleData({ command: 'cat <<EOF > file.txt\nline one\nline two\nEOF', cwd: '~', status: 'exit 0\nwith extra' } as unknown);
  expect(capped.command).toBe('cat <<EOF > file.txt\nline one\nline two\nEOF');
  expect(capped.status).toBe('exit 0 with extra');
});

test('a multi-line command reads as one flattened line folded, and as its own lines opened', () => {
  const command = 'cat <<EOF > file.txt\nline one\nline two\nEOF';
  const rec: ViewRecord = { kind: 'console', data: d({ command }), phase: 'done', startedAt: 0 };
  const folded = frameView(rec, { console: renderConsole }, { ...base, width: 60 }, {}).map((l) => l.spans.map((s) => s.text).join(''));
  expect(folded).toEqual(['cat <<EOF > file.txt line one line two EOF · ✓ 4s']);
  const open = frameView(rec, { console: renderConsole }, { ...base, width: 60, folded: false }, {}).map((l) => l.spans.map((s) => s.text).join(''));
  expect(open.slice(0, 4)).toEqual(['cat <<EOF > file.txt', 'line one', 'line two', 'EOF']);
  expect(open.at(-1)).toBe('✓ 4s');
});

test('capConsoleData caps movedTo and note the way it caps every other field', () => {
  // A path (movedTo) keeps the tighter cap; only the command itself is generous.
  const capped = capConsoleData({ command: 'cd sub', cwd: '~', movedTo: 'm'.repeat(VIEW_CAPS.path + 50), note: 'n'.repeat(200) } as unknown);
  expect(capped.movedTo).toHaveLength(VIEW_CAPS.path + 1);
  expect(capped.note).toHaveLength(81);
  // Absent stays absent — no field a session file has to carry for every command.
  expect(capConsoleData({ command: 'x', cwd: '~' }).movedTo).toBeUndefined();
  expect(capConsoleData({ command: 'x', cwd: '~' }).note).toBeUndefined();
});
