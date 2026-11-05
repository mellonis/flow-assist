// The background shells in the real app: `!cmd &`, the tree row and its pager, the kill key,
// the footer's count, and the question when a session with shells running is left.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostStateDir } from '../config/load.ts';
import { lockPath } from '../assistant/sessions.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settleUntil = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { await settle(2); if (cond()) return; await wait(20); }
};
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const rowsOf = (ui: UI) => frameOf(ui).split('\n');
const rowWith = (ui: UI, text: string) => rowsOf(ui).find((r) => r.includes(text)) ?? '';
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }

// The app is unmounted, not exited, so the jobs it still holds are ended here: the host's state
// file lists the groups this process started.
afterEach(() => {
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(hostStateDir(), 'shell-jobs.json'), 'utf8')) as { jobs?: { owner: number; pgid: number }[] };
    for (const e of entries.jobs ?? []) if (e.owner === process.pid) { try { process.kill(-e.pgid, 'SIGKILL'); } catch { /* gone */ } }
  } catch { /* no state file */ }
});

async function boot(extraShell: Record<string, unknown> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-person-sh-')));
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-person-sh-s-'));
  const model = new ScriptedModel();
  model.script([{ text: 'A answer.' }], [{ text: 'B answer.' }]);
  const ui = await bootApp(model, 130, 34, undefined, { sessions: { dir: sessions }, shell: { roots: [root], ...extraShell }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: 10_000 });
  await ui.press('F');
  return { ui, root, model, sessions };
}

test('`!sleep 60 &` runs in the background: no block, the field is free, a tree row and the footer count appear', async () => {
  const { ui } = await boot();
  await ui.type('!');
  await ui.type('echo up; sleep 60 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · echo up; sleep 60'));
  const row = rowWith(ui, '○ sh-1 · echo up; sleep 60');
  expect(row).toMatch(/○ sh-1 · echo up; sleep 60 · running <1m · [01] lines?/);
  // The output grows in place.
  await settleUntil(() => rowWith(ui, '○ sh-1 ·').includes('1 line'));
  expect(rowWith(ui, '○ sh-1 ·')).toContain('running <1m · 1 line');
  expect(frameOf(ui)).toContain('1 in backgro');
  expect(frameOf(ui)).toContain('sh-1 started in the background');
  // Not a waited-for command: no spinner, no console block, and the shell mode is left.
  expect(frameOf(ui)).not.toContain('✓');
  await ui.type('hello');
  expect(rowsOf(ui).some((r) => r.includes('› hello'))).toBe(true);
  ui.app.unmount();
});

test('&&, an escaped & and a quoted & stay a plain !command: it is waited for and leaves no job', async () => {
  const { ui } = await boot();
  await ui.type('!');
  await ui.type('echo a && echo b');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('✓'));
  await ui.type('!');
  await ui.type('echo "x &"');
  await ui.press('return');
  await settleUntil(() => (frameOf(ui).match(/✓/g) ?? []).length >= 2);
  expect(frameOf(ui)).not.toContain('sh-1');
  expect(frameOf(ui)).not.toContain('in backgro');
  ui.app.unmount();
});

test('↓ steps onto the row, ⏎ opens its output in the pager as a growing console block, Esc closes it', async () => {
  const { ui } = await boot();
  await ui.type('!');
  await ui.type('echo first; sleep 0.6; echo second; sleep 60 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · echo first'));
  await ui.press('down');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('│ first'));
  expect(frameOf(ui)).toContain('│ first');
  expect(frameOf(ui)).toContain('echo first; sleep 0.6; echo second; sleep 60');
  // It grows while the pager stays open.
  await settleUntil(() => frameOf(ui).includes('│ second'));
  expect(frameOf(ui)).toContain('│ second');
  await ui.press('escape');
  expect(frameOf(ui)).not.toContain('│ first');
  ui.app.unmount();
});

test('x on the row asks, y kills it (the end is a toast), n and Esc keep it', async () => {
  const { ui } = await boot();
  await ui.type('!');
  await ui.type('sleep 60 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · sleep 60'));
  await ui.press('down');
  expect(frameOf(ui)).toContain('x stop');
  await ui.press('x');
  expect(frameOf(ui)).toContain('kill sh-1? y yes · n no');
  await ui.press('n');
  expect(frameOf(ui)).not.toContain('kill sh-1?');
  expect(frameOf(ui)).toContain('○ sh-1 · sleep 60');
  await ui.press('x');
  await ui.press('escape');
  expect(frameOf(ui)).toContain('○ sh-1 · sleep 60');
  await ui.press('x');
  await ui.press('y');
  await settleUntil(() => !frameOf(ui).includes('○ sh-1 · sleep 60'));
  expect(frameOf(ui)).not.toContain('○ sh-1 · sleep 60');
  await settleUntil(() => frameOf(ui).includes('sh-1 killed (person) after'));
  expect(frameOf(ui)).toContain('sh-1 killed (person) after');
  expect(frameOf(ui)).not.toContain('in backgro');
  ui.app.unmount();
});

test('a job that ends on its own tells the person and keeps an answered row; opening it reads it and the row goes', async () => {
  const { ui } = await boot();
  await ui.type('!');
  await ui.type('echo bye; sleep 0.3; exit 5 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('sh-1 exited 5 after'));
  expect(frameOf(ui)).toContain('sh-1 exited 5 after');
  await settleUntil(() => rowWith(ui, '○ sh-1 ·').includes('exited 5'));
  expect(rowWith(ui, '○ sh-1 ·')).toMatch(/○ sh-1 · echo bye; sleep 0.3; exit 5 · exited 5 · 1 line/);
  await ui.press('down');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('│ bye'));
  expect(frameOf(ui)).toContain('│ bye');
  await ui.press('escape');
  await settleUntil(() => !rowWith(ui, '○ sh-1 ·').includes('exited 5'));
  expect(rowWith(ui, '○ sh-1 ·')).toBe('');
  ui.app.unmount();
});

test('x on an ended row dismisses it with no question; the job stays in /agents', async () => {
  const { ui } = await boot();
  await ui.type('!');
  await ui.type('echo bye; sleep 0.3; exit 5 &');
  await ui.press('return');
  await settleUntil(() => rowWith(ui, '○ sh-1 ·').includes('exited 5'));
  await ui.press('down');
  await settleUntil(() => frameOf(ui).includes('x dismiss'));
  expect(frameOf(ui)).toContain('x dismiss');
  await ui.press('x');
  await settleUntil(() => rowWith(ui, '○ sh-1 ·') === '');
  expect(frameOf(ui)).not.toContain('kill sh-1?');
  expect(rowWith(ui, '○ sh-1 ·')).toBe('');
  await ask(ui, '/agents');
  await settleUntil(() => frameOf(ui).includes('Agents'));
  expect(frameOf(ui)).toContain('exited 5');
  ui.app.unmount();
});

test('/agents lists the shell and kills it with x then y', async () => {
  const { ui } = await boot();
  await ui.type('!');
  await ui.type('sleep 60 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · sleep 60'));
  await ask(ui, '/agents');
  await settleUntil(() => frameOf(ui).includes('Agents'));
  expect(rowWith(ui, '○ sh-1 · sleep 60')).toContain('running <1m · 0 lines');
  await ui.press('x');
  expect(frameOf(ui)).toContain('kill sh-1? y yes · n no');
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('sh-1 killed (person)'));
  expect(frameOf(ui)).toContain('sh-1 killed (person)');
  ui.app.unmount();
});

test('!cmd & at the limit shows the running jobs and starts nothing', async () => {
  const { ui } = await boot({ maxBackground: 1 });
  await ui.type('!');
  await ui.type('sleep 60 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · sleep 60'));
  await ui.type('!');
  await ui.type('sleep 61 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('shell.maxBackground'));
  expect(frameOf(ui)).toContain('shell.maxBackground');
  expect(frameOf(ui)).toContain('○ sh-1 · sleep 60');
  expect(frameOf(ui)).not.toContain('sh-2');
  ui.app.unmount();
});

async function pickerFrame(ui: UI): Promise<string> {
  ui.backend.press({ name: 's', ctrl: true });
  await settle(3);
  const f = frameOf(ui);
  await ui.press('escape');
  await settle(2);
  return f;
}

test('/new with a shell running asks stop / keep running: Esc stays, k leaves it running (the picker reads the session working), s kills it', async () => {
  const { ui } = await boot();
  await ask(ui, 'session A question');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  await ui.type('!');
  await ui.type('sleep 60 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · sleep 60'));
  // Esc cancels the leave: the same session, the job running.
  await ask(ui, '/new');
  await settleUntil(() => frameOf(ui).includes('Background shells are running'));
  expect(frameOf(ui)).toContain('sh-1 · sleep 60 running');
  expect(frameOf(ui)).toContain('s stop');
  expect(frameOf(ui)).toContain('k keep running');
  await ui.press('escape');
  await settle(3);
  expect(frameOf(ui)).not.toContain('Background shells are running');
  expect(frameOf(ui)).toContain('A answer.');
  expect(frameOf(ui)).toContain('○ sh-1 · sleep 60');
  // Keep running: a new session; the first stays headless, working in the picker.
  await ask(ui, '/new');
  await settleUntil(() => frameOf(ui).includes('Background shells are running'));
  await ui.press('k');
  await settleUntil(() => !frameOf(ui).includes('A answer.'));
  expect(frameOf(ui)).not.toContain('A answer.');
  expect(frameOf(ui)).toContain('1 in backgro');
  const list = await pickerFrame(ui);
  const rowA = list.split('\n').find((r) => r.includes('session A question')) ?? '';
  expect(rowA).toContain('working');
  // Back in A, leave again and stop: the job is killed and A is put away as usual.
  ui.backend.press({ name: 's', ctrl: true });
  await settle(3);
  const rows = frameOf(ui).split('\n').filter((r) => / msgs? │/.test(r));
  const at = rows.findIndex((r) => r.includes('session A question'));
  for (let i = 0; i < at; i++) { await ui.press('down'); await settle(1); }
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  await ask(ui, '/new');
  await settleUntil(() => frameOf(ui).includes('Background shells are running'));
  await ui.press('s');
  await settleUntil(() => !frameOf(ui).includes('A answer.'));
  await settleUntil(() => !frameOf(ui).includes('in backgro'));
  expect(frameOf(ui)).not.toContain('in backgro');
  expect(frameOf(ui)).toContain('sh-1 killed (person) after');
  ui.app.unmount();
});

test('switching to another session from the picker asks the same question; Esc stays, k switches and leaves the shell running', async () => {
  const { ui } = await boot();
  await ask(ui, 'session A question');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  await ask(ui, '/new');
  await settle(4);
  await ask(ui, 'session B question');
  await settleUntil(() => frameOf(ui).includes('B answer.'));
  await ui.type('!');
  await ui.type('sleep 60 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · sleep 60'));
  const pickA = async () => {
    ui.backend.press({ name: 's', ctrl: true });
    await settle(3);
    const rows = frameOf(ui).split('\n').filter((r) => / msgs? │/.test(r));
    const at = rows.findIndex((r) => r.includes('session A question'));
    for (let i = 0; i < at; i++) { await ui.press('down'); await settle(1); }
    await ui.press('return');
    await settle(3);
  };
  await pickA();
  await settleUntil(() => frameOf(ui).includes('Background shells are running'));
  expect(frameOf(ui)).toContain('sh-1 · sleep 60 running');
  await ui.press('escape');
  await settle(3);
  expect(frameOf(ui)).toContain('B answer.');
  await pickA();
  await settleUntil(() => frameOf(ui).includes('Background shells are running'));
  await ui.press('k');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  expect(frameOf(ui)).toContain('A answer.');
  expect(frameOf(ui)).toContain('in backgro');
  ui.app.unmount();
}, 20_000);

test('x on an ended shell asks nothing: there is nothing to kill', async () => {
  const { ui } = await boot();
  await ui.type('!');
  await ui.type('echo hi &');
  await ui.press('return');
  await settleUntil(() => rowWith(ui, '○ sh-1 ·').includes('exited 0'));
  await ui.press('down');
  await ui.press('x');
  expect(frameOf(ui)).not.toContain('kill sh-1?');
  ui.app.unmount();
});

test('the pager shows the whole output of a long job: all 400 lines are reachable by paging', async () => {
  const { ui } = await boot();
  await ui.type('!');
  await ui.type('seq -f "row%g" 1 400; sleep 60 &');
  await ui.press('return');
  await settleUntil(() => rowWith(ui, '○ sh-1 ·').includes('400 lines'));
  await ui.press('down');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('│ row1'));
  expect(frameOf(ui)).not.toContain('lines cut');
  let seen = false;
  for (let i = 0; i < 80 && !seen; i++) { await ui.press('pagedown'); await settle(1); seen = /│ row400\b/.test(frameOf(ui)); }
  expect(seen).toBe(true);
  expect(frameOf(ui)).not.toContain('lines cut');
  ui.app.unmount();
}, 30_000);

test('`!cmd &` while a turn runs starts the job and leaves the turn alone', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-person-sh-')));
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'slow answer.' }]);
  const ui = await bootApp(model, 130, 34, undefined, { shell: { roots: [root] }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: 10_000 });
  await ui.press('F');
  await ask(ui, 'a slow question');
  await settleUntil(() => model.held);
  await ui.type('!');
  await ui.type('sleep 60 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · sleep 60'));
  expect(frameOf(ui)).toContain('○ sh-1 · sleep 60');
  expect(frameOf(ui)).not.toContain('still running');
  model.release();
  await settleUntil(() => frameOf(ui).includes('slow answer.'));
  expect(frameOf(ui)).toContain('slow answer.');
  expect(frameOf(ui)).toContain('○ sh-1 · sleep 60');
  ui.app.unmount();
}, 20_000);

test('/resume n with a shell running asks the same question, and k switches', async () => {
  const { ui } = await boot();
  await ask(ui, 'session A question');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  await ask(ui, '/new');
  await settle(4);
  await ask(ui, 'session B question');
  await settleUntil(() => frameOf(ui).includes('B answer.'));
  await ui.type('!');
  await ui.type('sleep 60 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · sleep 60'));
  await ask(ui, '/resume 2');
  await settleUntil(() => frameOf(ui).includes('Background shells are running'));
  expect(frameOf(ui)).toContain('sh-1 · sleep 60 running');
  await ui.press('k');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  expect(frameOf(ui)).toContain('A answer.');
  ui.app.unmount();
}, 20_000);

test('the leave panel survives its jobs ending while it is open: k and s still leave', async () => {
  const { ui } = await boot();
  await ask(ui, 'session A question');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  await ui.type('!');
  await ui.type('sleep 1 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · sleep 1'));
  await ask(ui, '/new');
  await settleUntil(() => frameOf(ui).includes('Background shells are running'));
  await settleUntil(() => frameOf(ui).includes('sh-1 exited 0 after'), 4000);
  expect(frameOf(ui)).toContain('Background shells are running');
  await ui.press('s');
  await settleUntil(() => !frameOf(ui).includes('A answer.'));
  expect(frameOf(ui)).not.toContain('Background shells are running');
  expect(frameOf(ui)).not.toContain('A answer.');
  ui.app.unmount();
}, 20_000);

test('a switch refused after the question (the session is open in another process) brings the picker back with its notice', async () => {
  const { ui, sessions } = await boot();
  await ask(ui, 'session A question');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  await ask(ui, '/new');
  await settle(4);
  await ask(ui, 'session B question');
  await settleUntil(() => frameOf(ui).includes('B answer.'));
  await ui.type('!');
  await ui.type('sleep 60 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · sleep 60'));
  ui.backend.press({ name: 's', ctrl: true });
  await settle(3);
  const rows = frameOf(ui).split('\n').filter((r) => / msgs? │/.test(r));
  const at = rows.findIndex((r) => r.includes('session A question'));
  for (let i = 0; i < at; i++) { await ui.press('down'); await settle(1); }
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('Background shells are running'));
  // Meanwhile another process takes session A.
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const aFile = walk(sessions).find((f) => { if (!f.endsWith('.json')) return false; const t = fs.readFileSync(f, 'utf8'); return t.includes('session A question') && !t.includes('session B question'); })!;
  fs.writeFileSync(lockPath(path.dirname(aFile), path.basename(aFile, '.json')), JSON.stringify({ pid: process.ppid, host: os.hostname(), token: 'another-process', at: new Date().toISOString() }));
  await ui.press('k');
  await settleUntil(() => frameOf(ui).includes('is open in another flow-assist process'));
  expect(frameOf(ui)).toContain('is open in another flow-assist process');
  expect(frameOf(ui)).toContain('Sessions');
  ui.app.unmount();
}, 20_000);

test('/resume n refused after the question leaves the chat as it was: no picker opens', async () => {
  const { ui, sessions } = await boot();
  await ask(ui, 'session A question');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  await ask(ui, '/new');
  await settle(4);
  await ask(ui, 'session B question');
  await settleUntil(() => frameOf(ui).includes('B answer.'));
  await ui.type('!');
  await ui.type('sleep 60 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · sleep 60'));
  await ask(ui, '/resume 2');
  await settleUntil(() => frameOf(ui).includes('Background shells are running'));
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const aFile = walk(sessions).find((f) => { if (!f.endsWith('.json')) return false; const t = fs.readFileSync(f, 'utf8'); return t.includes('session A question') && !t.includes('session B question'); })!;
  fs.writeFileSync(lockPath(path.dirname(aFile), path.basename(aFile, '.json')), JSON.stringify({ pid: process.ppid, host: os.hostname(), token: 'another-process', at: new Date().toISOString() }));
  await ui.press('k');
  await settleUntil(() => frameOf(ui).includes('is open in another flow-assist process'));
  expect(frameOf(ui)).toContain('is open in another flow-assist process');
  expect(frameOf(ui)).toContain('B answer.');
  expect(frameOf(ui)).not.toContain('Sessions ·');
  ui.app.unmount();
}, 20_000);

test('/agents keeps the shells that ended: one the person killed and one already opened stay listed, and ⏎ opens their output in the pager', async () => {
  const { ui } = await boot();
  await ui.type('!');
  await ui.type('echo killed-out; sleep 60 &');
  await ui.press('return');
  await settleUntil(() => rowWith(ui, '○ sh-1 ·').includes('1 line'));
  await ui.type('!');
  await ui.type('echo opened-out &');
  await ui.press('return');
  await settleUntil(() => rowWith(ui, '○ sh-2 ·').includes('exited 0'));
  // The person kills sh-1 (never unread), and opens sh-2 once (read).
  await ui.press('down');
  await ui.press('x');
  await ui.press('y');
  await settleUntil(() => !rowWith(ui, '○ sh-1 ·'));
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('│ opened-out'));
  await ui.press('escape');
  await settleUntil(() => !rowWith(ui, '○ sh-2 ·'));
  await ask(ui, '/agents');
  await settleUntil(() => frameOf(ui).includes('Agents'));
  expect(rowWith(ui, '○ sh-1 · echo killed-out')).toContain('killed');
  expect(rowWith(ui, '○ sh-2 · echo opened-out')).toContain('exited 0');
  await ui.press('down');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('│ killed-out'));
  expect(frameOf(ui)).toContain('│ killed-out');
  ui.app.unmount();
}, 30_000);

test('leaving a session whose only running shell belongs to a subagent asks, and listing it names the shell', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-person-sh-')));
  const model = new ScriptedModel();
  const child = model.when((req) => /SUBSH/.test(String(req.messages.findLast((m: { role: string }) => m.role === 'user')?.content ?? '')));
  child.script([{ tool: 'run_command', args: { command: 'sleep 60', background: true } }], [{ text: 'sub done' }]);
  model.script([{ text: 'A answer.' }]);
  const ui = await bootApp(model, 130, 34, undefined, { shell: { roots: [root] }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: 10_000 });
  await ui.press('F');
  await ask(ui, 'session A question');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  await ask(ui, '/subagent SUBSH go');
  await settleUntil(() => frameOf(ui).includes('Confirm write: run_command'));
  await wait(800);
  await ui.press('y');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · sleep 60'));
  expect(frameOf(ui)).toContain('○ sh-1 · sleep 60');
  await ask(ui, '/new');
  await settleUntil(() => frameOf(ui).includes('Background shells are running'));
  expect(frameOf(ui)).toContain('sh-1 · sleep 60 running');
  await ui.press('escape');
  ui.app.unmount();
}, 30_000);

test('the picker\'s delete refusal of a session kept open for a running shell names the shell', async () => {
  const { ui } = await boot();
  await ask(ui, 'session A question');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  await ui.type('!');
  await ui.type('sleep 60 &');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('○ sh-1 · sleep 60'));
  await ask(ui, '/new');
  await settleUntil(() => frameOf(ui).includes('Background shells are running'));
  await ui.press('k');
  await settleUntil(() => !frameOf(ui).includes('A answer.'));
  ui.backend.press({ name: 's', ctrl: true });
  await settle(3);
  const rows = frameOf(ui).split('\n').filter((r) => / msgs? │/.test(r));
  const at = rows.findIndex((r) => r.includes('session A question'));
  for (let i = 0; i < at; i++) { await ui.press('down'); await settle(1); }
  ui.backend.press({ name: 'x', ctrl: true });
  await settleUntil(() => frameOf(ui).includes('cannot be deleted'));
  expect(frameOf(ui).replace(/[│\s]+/g, ' ')).toContain('its turn, its children and its background shells have ended');
  ui.app.unmount();
}, 30_000);
