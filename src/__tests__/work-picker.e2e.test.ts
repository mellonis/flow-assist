// The work picker (`/work`, its `work` key and `↓` on an empty field): the session's live
// subagents and background shells as a bottom strip, one tab each (docs/usage.md). Enter
// opens what is under the cursor — a subagent's watch, a shell's output in the pager —
// and ctrl+d stops a subagent or kills a shell after the picker's own y/n. The picker is
// one-shot: Esc closes it back to the chat. The real app on the scripted model; the pause
// before a parked request takes the keyboard is read from `askClock`, which the tests
// move.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askClock } from '../assistant/child-ask-guard.ts';
import { hostStateDir } from '../config/load.ts';
import { keyGlyph } from '../playback/keys.ts';
import { ScriptedModel, bootApp, firstUser, settle, type Turn } from './helpers/scripted';

const realFetch = globalThis.fetch;
const realNow = askClock.now;
const clock = { t: 10_000 };
afterEach(() => {
  globalThis.fetch = realFetch;
  askClock.now = realNow;
  // The app is unmounted, not exited, so the shells it still holds are ended here: the
  // host's state file lists the groups this process started.
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(hostStateDir(), 'shell-jobs.json'), 'utf8')) as { jobs?: { owner: number; pgid: number }[] };
    for (const e of entries.jobs ?? []) if (e.owner === process.pid) { try { process.kill(-e.pgid, 'SIGKILL'); } catch { /* gone */ } }
  } catch { /* no state file */ }
});

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const rowsOf = (ui: UI) => frameOf(ui).split('\n');
const pause = () => { clock.t += 700; };
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
// The tool results a request carried — what a subagent's answer reached it as.
const results = (req: { messages: { role: string; content?: unknown }[] } | undefined): string[] =>
  (req?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content).replace(/^OK: /, ''));

// A subagent the person starts: held at its first step, then its request of the kind.
// `outer` starts a task of its own (`beta one`) whose first command asks the person y/n —
// a request parked BELOW the subagent; `quiet` starts one that just answers (`gamma one`),
// so it ends by itself while anything is looking at it.
const labelOf = (mark: string) => `${mark.toLowerCase()}-go`;
const QUIET_TASK = 'gamma one';
interface Kid { mark: string; kind: 'run' | 'ask' | 'outer' | 'quiet' }
const requestOf = (kid: Kid, root: string) => (kid.kind === 'ask'
  ? { tool: 'ask_parent', args: { question: `Q-${kid.mark}?` } }
  : kid.kind === 'outer'
    ? { tool: 'subagent', args: { task: 'beta one' } }
    : kid.kind === 'quiet'
      ? { tool: 'subagent', args: { task: QUIET_TASK } }
      : { tool: 'run_command', args: { command: `touch ${path.join(root, `${kid.mark}.txt`)}` } });
const scriptOf = (kid: Kid, root: string): Turn[] => [[{ hold: true as const }, requestOf(kid, root)], [{ text: `${kid.mark} settled` }]];
// The task `outer`'s subagent tool starts: matched by the task text in its prompt. Its
// first step asks the person to approve a command.
const TASK_TURN = (root: string): Turn[] => [[{ hold: true as const }, { tool: 'run_command', args: { command: `touch ${path.join(root, 'beta.txt')}` } }], [{ text: 'BETA settled' }]];

interface Rig { ui: UI; children: ScriptedModel[]; kids: Kid[] }
async function boot(kids: Kid[] = []): Promise<Rig> {
  clock.t = 10_000;
  askClock.now = () => clock.t;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-workpicker-')));
  const model = new ScriptedModel();
  const children = kids.map((kid) => {
    const child = model.when((req) => firstUser(req).includes(kid.mark));
    child.script(...scriptOf(kid, root));
    return child;
  });
  if (kids.some((k) => k.kind === 'outer')) {
    const task = model.when((req) => firstUser(req).includes('beta one'));
    task.script(...TASK_TURN(root));
    children.push(task);
  }
  if (kids.some((k) => k.kind === 'quiet')) {
    const task = model.when((req) => firstUser(req).includes(QUIET_TASK));
    task.script([{ hold: true as const }, { text: 'QUIET settled' }]);
    children.push(task);
  }
  const ui = await bootApp(model, 130, 34, undefined, {
    sessions: { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fa-workpicker-s-')) },
    shell: { roots: [root] },
    ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false },
  }, { toastMs: 10_000 });
  return { ui, children, kids };
}
const spawn = async (rig: Rig, i: number) => {
  await ask(rig.ui, `/subagent ${rig.kids[i]!.mark} go`);
  await settleUntil(() => rig.children[i]!.held);
};
const released = async (rig: Rig, i: number) => {
  rig.children[i]!.release();
  await settleUntil(() => rig.children[i]!.requests.length >= 1 && !rig.children[i]!.held);
  await settle(10);
};
const shell = async (ui: UI, line: string, row: string) => {
  await ui.type('!');
  await ui.type(line);
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes(row));
};
// The capital opens the picker wherever the chat does not have the keyboard: Esc Esc
// closes the chat, and `J` brings it back with the picker up in it.
const openByKey = async (ui: UI) => {
  await ui.press('escape', 'escape');
  await ui.press('J');
  await settleUntil(() => frameOf(ui).includes('Flow Assist · Work'));
};
const openByCommand = async (ui: UI) => {
  await ask(ui, '/work');
  await settleUntil(() => frameOf(ui).includes('Flow Assist · Work'));
};
// The panel is up; `panelUp` reads the frame, never a state the key set.
const panelUp = (ui: UI) => frameOf(ui).includes('Flow Assist · Work');
const fieldRow = (ui: UI) => rowsOf(ui).findLastIndex((r) => r.includes('› '));
// The strip's own rows: inside its frame, from the tab row down to the frame's bottom
// border — the chat above it says the same names (`subagent «hyn-go» started`), so a test
// that asks what the PICKER says reads only this.
function stripText(ui: UI) {
  const rows = rowsOf(ui);
  const heading = rows.findIndex((r) => r.includes('Flow Assist · Work'));
  const end = rows.findIndex((r, i) => i > heading && r.trimStart().startsWith('╰'));
  return rows.slice(heading + 1, end > heading ? end : rows.length).join('\n');
}
// The row the cursor is on is the one with the panel's mark in front — a frame alone says
// it, as a person sees it. Read through `stripText`: the chat above the strip says the
// same names, and its `› ` field row would otherwise satisfy the mark.
const marked = (ui: UI, text: string) => stripText(ui).split('\n').some((r) => r.includes(`› ${text}`));
// The style of the cell where `text` starts: the current tab is drawn inverse, so only a
// frame's cells can tell which one it is.
function styleAt(ui: UI, text: string) {
  const rows = rowsOf(ui);
  const y = rows.findIndex((r) => r.includes(text));
  if (y < 0) throw new Error(`"${text}" is not on screen:\n${frameOf(ui)}`);
  const buffer = (ui.backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { inverse?: boolean; dim?: boolean } } } | null }).lastBuffer;
  return buffer!.get(rows[y]!.indexOf(text), y).style;
}

test('a down-arrow on an empty field opens the work panel', async () => {
  const rig = await boot([{ mark: 'HYN', kind: 'run' }]);
  await rig.ui.press('F');
  await spawn(rig, 0);
  await shell(rig.ui, 'echo up; sleep 60 &', '○ sh-1');
  expect(panelUp(rig.ui)).toBe(false);
  // Nothing typed: ↓ is the door.
  await rig.ui.press('down');
  await settleUntil(() => panelUp(rig.ui));
  expect(panelUp(rig.ui)).toBe(true);
  expect(frameOf(rig.ui)).toContain('⏎ open');
  await rig.ui.press('escape');
  await settleUntil(() => !panelUp(rig.ui));
  expect(panelUp(rig.ui)).toBe(false);
  // The accepted edge: a walk through the history and back to the empty line leaves ↓
  // the door's — one more opens the panel.
  await rig.ui.press('up', 'up');
  await settle(2);
  await rig.ui.press('down', 'down');
  await settle(2);
  expect(rowsOf(rig.ui)[fieldRow(rig.ui)]).not.toContain('/subagent');
  expect(panelUp(rig.ui)).toBe(false);
  await rig.ui.press('down');
  await settleUntil(() => panelUp(rig.ui));
  expect(panelUp(rig.ui)).toBe(true);
  rig.ui.app.unmount();
}, 20_000);

test('no work — the down-arrow stays silent', async () => {
  const rig = await boot();
  await rig.ui.press('F');
  await rig.ui.press('down');
  await settle(4);
  expect(panelUp(rig.ui)).toBe(false);
  // The field is still empty: the key typed nothing either — the hint is the empty
  // field's own.
  expect(frameOf(rig.ui)).toContain('↑↓ history');
  rig.ui.app.unmount();
}, 20_000);

test('a bang step or a recall keeps the down-arrow away from the panel', async () => {
  const rig = await boot([{ mark: 'HYN', kind: 'run' }]);
  await rig.ui.press('F');
  await spawn(rig, 0);
  // A bang level up: the field is a command's, not the door's.
  await rig.ui.press('!');
  await rig.ui.press('down');
  await settle(4);
  expect(panelUp(rig.ui)).toBe(false);
  // Stepped back down, the door works.
  await rig.ui.press('backspace');
  await rig.ui.press('down');
  await settleUntil(() => panelUp(rig.ui));
  expect(panelUp(rig.ui)).toBe(true);
  await rig.ui.press('escape');
  await settleUntil(() => !panelUp(rig.ui));
  // A recalled line keeps ↓ for the walk: ↑ shows it, ↓ walks off it, and the panel
  // stays away.
  await rig.ui.press('up');
  await settle(2);
  expect(rowsOf(rig.ui)[fieldRow(rig.ui)]).toContain('/subagent HYN go');
  await rig.ui.press('down');
  await settle(2);
  expect(rowsOf(rig.ui)[fieldRow(rig.ui)]).not.toContain('/subagent');
  expect(panelUp(rig.ui)).toBe(false);
  rig.ui.app.unmount();
}, 20_000);

test('the picker opens on its key with both tabs and their rows', async () => {
  const rig = await boot([{ mark: 'HYN', kind: 'run' }]);
  await rig.ui.press('F');
  await spawn(rig, 0);
  await shell(rig.ui, 'echo up; sleep 60 &', '○ sh-1');
  await openByKey(rig.ui);
  const frame = frameOf(rig.ui);
  // The two tabs and their counts, the subagent's row on the one that is open.
  expect(frame).toContain('Subagents (1)');
  expect(frame).toContain('Shells (1)');
  expect(stripText(rig.ui)).toContain('hyn-go');
  expect(stripText(rig.ui)).not.toContain('sh-1 · echo up');
  // The key-caps hint at the bottom names the keys as glyphs.
  expect(frame).toContain(`${keyGlyph('return')} open`);
  expect(frame).toContain(`${keyGlyph('ctrl+d')} stop/kill`);
  // → is the Shells tab: the shell's row, its owner the chat's.
  await rig.ui.press('right');
  await settle();
  expect(stripText(rig.ui)).toContain('sh-1 · echo up; sleep 60');
  expect(stripText(rig.ui)).toContain('running — this chat');
  // Esc closes it; /work opens the same panel again, on Subagents.
  await rig.ui.press('escape');
  await settleUntil(() => !frameOf(rig.ui).includes('Flow Assist · Work'));
  expect(frameOf(rig.ui)).not.toContain('Subagents');
  await openByCommand(rig.ui);
  expect(stripText(rig.ui)).toContain('Subagents (1)');
  expect(stripText(rig.ui)).toContain('hyn-go');
  rig.ui.app.unmount();
}, 20_000);

test('the tabs split the work; ←→ switch and the counts follow', async () => {
  const rig = await boot([{ mark: 'HYN', kind: 'run' }, { mark: 'ALK', kind: 'run' }]);
  await rig.ui.press('F');
  await spawn(rig, 0);
  await spawn(rig, 1);
  await shell(rig.ui, 'echo up; sleep 60 &', '○ sh-1');
  await rig.ui.press('down');
  await settleUntil(() => panelUp(rig.ui));
  // Each tab counts its own rows, and the list is the open tab's alone: no group header
  // stands over these rows.
  let frame = frameOf(rig.ui);
  expect(frame).toContain('Subagents (2)');
  expect(frame).toContain('Shells (1)');
  expect(stripText(rig.ui)).toContain('hyn-go');
  expect(stripText(rig.ui)).toContain('alk-go');
  expect(stripText(rig.ui)).not.toContain('sh-1 · echo up');
  expect(marked(rig.ui, 'hyn-go')).toBe(true);
  // → : the Shells tab is the inverse one, the list is the shell's, its cursor on its
  // first row.
  await rig.ui.press('right');
  await settle();
  expect(styleAt(rig.ui, 'Shells (1)').inverse).toBe(true);
  expect(styleAt(rig.ui, 'Subagents (2)').inverse).toBeFalsy();
  expect(stripText(rig.ui)).toContain('sh-1 · echo up');
  expect(stripText(rig.ui)).not.toContain('hyn-go');
  expect(marked(rig.ui, 'sh-1 ·')).toBe(true);
  // ← back: the Subagents tab again, and its cursor on the tab's FIRST row whatever row
  // it was left on — the same for the shell tab on the way back.
  await rig.ui.press('left');
  await settle();
  await rig.ui.press('down');
  await settle();
  expect(marked(rig.ui, 'alk-go')).toBe(true);
  await rig.ui.press('right');
  await settle();
  await rig.ui.press('left');
  await settle();
  expect(marked(rig.ui, 'hyn-go')).toBe(true);
  expect(marked(rig.ui, 'alk-go')).toBe(false);
  expect(styleAt(rig.ui, 'Subagents (2)').inverse).toBe(true);
  rig.ui.app.unmount();
  // A tab with nothing in it draws the strip's dim `none` message — no row at all — and
  // both arrows still switch AWAY from it: the way out of an empty tab is the same key
  // that led in.
  const only = await boot([{ mark: 'HYN', kind: 'run' }]);
  await only.ui.press('F');
  await spawn(only, 0);
  await only.ui.press('down');
  await settleUntil(() => panelUp(only.ui));
  await only.ui.press('right');
  await settle();
  expect(stripText(only.ui)).toContain('Shells (0)');
  expect(stripText(only.ui)).toContain('none');
  expect(styleAt(only.ui, 'none').dim).toBe(true);
  expect(styleAt(only.ui, 'Shells (0)').inverse).toBe(true);
  expect(stripText(only.ui)).not.toContain('hyn-go');
  // ← out of the empty tab: the Subagents tab again, its row drawn and its cursor on it.
  await only.ui.press('left');
  await settle();
  expect(stripText(only.ui)).toContain('Subagents (1)');
  expect(stripText(only.ui)).not.toContain('none');
  expect(marked(only.ui, 'hyn-go')).toBe(true);
  // → leads into it once more, from a tab that has rows.
  await only.ui.press('right');
  await settle();
  expect(stripText(only.ui)).toContain('Shells (0)');
  expect(marked(only.ui, 'hyn-go')).toBe(false);
  only.ui.app.unmount();
}, 30_000);

test('the panel is the bottom strip: the tabs under its top border and the hint at its own', async () => {
  const rig = await boot([{ mark: 'HYN', kind: 'run' }, { mark: 'ALK', kind: 'run' }]);
  await rig.ui.press('F');
  await spawn(rig, 0);
  await spawn(rig, 1);
  await shell(rig.ui, 'sleep 60 &', '○ sh-1');
  await rig.ui.press('down');
  await settleUntil(() => panelUp(rig.ui));
  const rows = rowsOf(rig.ui);
  const heading = rows.findIndex((r) => r.includes('Flow Assist · Work'));
  // ONE tab row, right under the frame's top border.
  expect(rows[heading + 1]).toContain('Subagents (2)');
  expect(rows[heading + 1]).toContain('Shells (1)');
  // The hint is the strip's last row inside the frame, the way out first.
  const hint = rows.findIndex((r) => r.includes(`${keyGlyph('up')}${keyGlyph('down')} pick`));
  expect(hint).toBeGreaterThan(heading + 1);
  expect(rows[hint]).toContain([
    `${keyGlyph('escape')} close`,
    `${keyGlyph('left')}${keyGlyph('right')} tabs`,
    `${keyGlyph('up')}${keyGlyph('down')} pick`,
    `${keyGlyph('return')} open`,
    `${keyGlyph('ctrl+d')} stop/kill`,
  ].join(' · '));
  // The hint sits on the frame's last row: nothing of the strip is under it.
  expect(rows[hint + 1]).toContain('╰');
  expect(rows[hint + 1]).toContain('╯');
  rig.ui.app.unmount();
}, 20_000);

test('enter opens what is under the cursor', async () => {
  const rig = await boot([{ mark: 'HYN', kind: 'run' }]);
  await rig.ui.press('F');
  await spawn(rig, 0);
  await shell(rig.ui, 'echo up; sleep 60 &', '○ sh-1');
  await openByKey(rig.ui);
  // The subagent row (the cursor starts on the first row a key runs): the picker closes
  // and its watch is on, Esc back to the tree rows under the field and Esc again to the
  // field, where a command is typed.
  await rig.ui.press('return');
  await settleUntil(() => !frameOf(rig.ui).includes('Flow Assist · Work'));
  expect(frameOf(rig.ui)).toMatch(/Flow Assist \(scripted\) · hyn-go/);
  await rig.ui.press('escape');
  await settleUntil(() => frameOf(rig.ui).includes('○ sh-1'));
  await rig.ui.press('escape');
  await settle(4);
  // The shell row: its output pager is up over the kept tail.
  await openByCommand(rig.ui);
  await rig.ui.press('right');
  await rig.ui.press('return');
  await settleUntil(() => frameOf(rig.ui).includes('│ up'));
  expect(frameOf(rig.ui)).toContain('│ up');
  rig.ui.app.unmount();
}, 20_000);

test('ctrl+d kills a shell after its own y/n', async () => {
  const rig = await boot();
  await rig.ui.press('F');
  await shell(rig.ui, 'sleep 60 &', '○ sh-1');
  await shell(rig.ui, 'sleep 60 &', '○ sh-2');
  await openByKey(rig.ui);
  // The cursor starts on the first row a key runs — sh-1; ctrl+d asks in its row's place.
  await rig.ui.backend.press({ name: 'd', ctrl: true });
  await settle();
  expect(frameOf(rig.ui)).toMatch(/kill sh-1\? y yes · n no/);
  // `n` cancels: the job is alive and the row is back to its state.
  await rig.ui.press('n');
  await settleUntil(() => !frameOf(rig.ui).includes('kill sh-1'));
  expect(frameOf(rig.ui)).toContain('sh-1 · sleep 60');
  expect(frameOf(rig.ui)).toContain('running — this chat');
  // ctrl+d again asks, and ctrl+d drops the question the same key asked: the chord
  // stays the panel's through the whole exchange — nothing arms the exit, and the job
  // is alive.
  await rig.ui.backend.press({ name: 'd', ctrl: true });
  await settleUntil(() => frameOf(rig.ui).includes('kill sh-1'));
  await rig.ui.backend.press({ name: 'd', ctrl: true });
  await settleUntil(() => !frameOf(rig.ui).includes('kill sh-1'));
  expect(frameOf(rig.ui)).toContain('sh-1 · sleep 60');
  // ctrl+d, a row away, `y`: the question is answered for the job it NAMES — sh-1 dies
  // and sh-2 goes on (a cursor moved elsewhere never kills the wrong job).
  await rig.ui.backend.press({ name: 'd', ctrl: true });
  await settleUntil(() => frameOf(rig.ui).includes('kill sh-1'));
  await rig.ui.press('down');
  await rig.ui.press('y');
  await settleUntil(() => rowsOf(rig.ui).some((r) => r.includes('sh-1 · sleep 60') && r.includes('killed (person)')));
  const row1 = rowsOf(rig.ui).find((r) => r.includes('sh-1 · sleep 60')) ?? '';
  const row2 = rowsOf(rig.ui).find((r) => r.includes('sh-2 · sleep 60')) ?? '';
  expect(row1).toContain('killed (person)');
  expect(row2).toContain('running');
  // Ctrl+D was the panel's, not the exit arm's: nothing armed, nothing exited.
  expect(frameOf(rig.ui)).not.toContain('^d again');
  expect(rig.ui.exits()).toBe(0);
  rig.ui.app.unmount();
}, 20_000);

test('a shell that ended under the question is not killed twice', async () => {
  const rig = await boot();
  await rig.ui.press('F');
  await shell(rig.ui, 'sleep 2 &', '○ sh-1');
  await openByKey(rig.ui);
  // ctrl+d asks for the running job, in its row's place.
  await rig.ui.backend.press({ name: 'd', ctrl: true });
  await settleUntil(() => frameOf(rig.ui).includes('kill sh-1? y yes · n no'));
  // The job ends by itself while its question is up; the end is told (the toast), and the
  // question still stands for the row it names.
  await settleUntil(() => frameOf(rig.ui).includes('sh-1 exited 0'), 900);
  expect(stripText(rig.ui)).toContain('kill sh-1? y yes · n no');
  // `y` answers the question, finds the job ended, and says so: nothing is killed and
  // the row keeps the state it ended in.
  await rig.ui.press('y');
  await settle();
  expect(frameOf(rig.ui)).toContain('it has ended — nothing to kill');
  expect(frameOf(rig.ui)).not.toContain('kill sh-1?');
  expect(stripText(rig.ui)).toContain('sh-1 · sleep 2');
  expect(stripText(rig.ui)).toContain('exited 0');
  expect(rig.ui.exits()).toBe(0);
  rig.ui.app.unmount();
}, 20_000);

test('ctrl+d stops a subagent after its question, and y names it', async () => {
  const rig = await boot([{ mark: 'HYN', kind: 'run' }]);
  await rig.ui.press('F');
  await spawn(rig, 0);
  await openByKey(rig.ui);
  // The cursor starts on the tab's first row; ctrl+d asks in that row's place, naming it.
  await rig.ui.backend.press({ name: 'd', ctrl: true });
  await settle();
  expect(frameOf(rig.ui)).toContain('stop hyn-go? y yes · n no');
  expect(stripText(rig.ui)).not.toContain('running —');
  // `n` cancels: the subagent is still at work and the row is back to its state.
  await rig.ui.press('n');
  await settleUntil(() => !frameOf(rig.ui).includes('stop hyn-go'));
  expect(frameOf(rig.ui)).toContain('hyn-go');
  expect(rig.children[0]!.held).toBe(true);
  // ctrl+d again asks, and the ctrl+d that asked drops the question: the chord stays the
  // panel's through the whole exchange, and nothing arms the exit.
  await rig.ui.backend.press({ name: 'd', ctrl: true });
  await settleUntil(() => frameOf(rig.ui).includes('stop hyn-go'));
  await rig.ui.backend.press({ name: 'd', ctrl: true });
  await settleUntil(() => !frameOf(rig.ui).includes('stop hyn-go'));
  expect(frameOf(rig.ui)).toContain('hyn-go');
  expect(frameOf(rig.ui)).not.toContain('^d again');
  // ctrl+d, then `y`: the node is stopped with what it started, and its row leaves the
  // live tab — the panel stays up and follows the work.
  await rig.ui.backend.press({ name: 'd', ctrl: true });
  await settleUntil(() => frameOf(rig.ui).includes('stop hyn-go'));
  await rig.ui.press('y');
  await settleUntil(() => frameOf(rig.ui).includes('Subagents (0)'));
  expect(frameOf(rig.ui)).toContain('◆ hyn-go stopped:');
  expect(stripText(rig.ui)).toContain('none');
  expect(stripText(rig.ui)).not.toContain('hyn-go');
  expect(rig.ui.exits()).toBe(0);
  rig.ui.app.unmount();
}, 20_000);

test('a subagent that ended under the question is not stopped twice', async () => {
  const rig = await boot([{ mark: 'QUIET', kind: 'quiet' }, { mark: 'HYN', kind: 'run' }]);
  await rig.ui.press('F');
  await spawn(rig, 0);
  await spawn(rig, 1);
  await rig.ui.press('down');
  await settleUntil(() => panelUp(rig.ui));
  // `quiet-go` starts a task of its own; its row sits under its parent's, and the task
  // is held at its first step.
  await released(rig, 0);
  const task = rig.children[2]!;
  await settleUntil(() => task.held);
  await settleUntil(() => frameOf(rig.ui).includes('gamma one'));
  await rig.ui.press('down');
  await settle();
  expect(marked(rig.ui, 'quiet-go › gamma one')).toBe(true);
  await rig.ui.backend.press({ name: 'd', ctrl: true });
  await settle();
  expect(frameOf(rig.ui)).toContain('stop gamma one? y yes · n no');
  // The task answers and ends while its question is up: the tab counts what is live, and
  // the question stands for the row it names.
  task.release();
  await settleUntil(() => frameOf(rig.ui).includes('Subagents (2)'));
  expect(stripText(rig.ui)).toContain('stop gamma one? y yes · n no');
  expect(stripText(rig.ui)).not.toContain('gamma one ·');
  // The counts are live work: the ended task has left them while its question stands
  // beside what is left. While the question stands the tabs' arrows are not offered —
  // the hint says the question's keys and the rows' move, never `←→ tabs`, which would
  // do nothing.
  expect(stripText(rig.ui)).toContain(`${keyGlyph('up')}${keyGlyph('down')} pick`);
  expect(stripText(rig.ui)).toContain(`${keyGlyph('ctrl+d')} cancel`);
  expect(stripText(rig.ui)).not.toContain('tabs');
  // `y` answers the row the question NAMES: the task is gone, and the live subagent the
  // cursor is on is not the one stopped.
  await rig.ui.press('up');
  await settle();
  expect(marked(rig.ui, 'hyn-go')).toBe(true);
  await rig.ui.press('y');
  await settle();
  expect(frameOf(rig.ui)).toContain('gamma one has ended — nothing to stop');
  expect(frameOf(rig.ui)).not.toContain('stop gamma one');
  expect(frameOf(rig.ui)).toContain('hyn-go');
  expect(rig.children[1]!.held).toBe(true);
  expect(rig.ui.exits()).toBe(0);
  rig.ui.app.unmount();
}, 20_000);

test('enter on a waiting subagent lands on its request', async () => {
  const rig = await boot([{ mark: 'ASK', kind: 'ask' }]);
  await rig.ui.press('F');
  await spawn(rig, 0);
  await ask(rig.ui, '/work');
  await settleUntil(() => frameOf(rig.ui).includes('Flow Assist · Work'));
  // Its question parks while the picker is up: the row says so, nothing is answered.
  await released(rig, 0);
  await settleUntil(() => frameOf(rig.ui).includes('Subagents') && frameOf(rig.ui).includes('? waiting for you'));
  expect(frameOf(rig.ui)).not.toContain('? from «ask-go»');
  pause();
  // Enter closes the picker and the request block takes the keyboard.
  await rig.ui.press('return');
  await settleUntil(() => frameOf(rig.ui).includes('? from «ask-go»'));
  expect(frameOf(rig.ui)).not.toContain('Flow Assist · Work');
  // The keyboard is the block's: the answer reaches the subagent.
  pause();
  await rig.ui.type('fine');
  await rig.ui.press('return');
  await settleUntil(() => rig.children[0]!.requests.length >= 2);
  expect(results(rig.children[0]!.requests[1])).toEqual(['The person answered: fine']);
  rig.ui.app.unmount();
}, 20_000);

test('a sub whose grandchild waits on you is marked too, and Enter lands on that request', async () => {
  const rig = await boot([{ mark: 'ALPHA', kind: 'outer' }]);
  await rig.ui.press('F');
  await spawn(rig, 0);
  await ask(rig.ui, '/work');
  await settleUntil(() => frameOf(rig.ui).includes('Flow Assist · Work'));
  // The task the subagent started parks its y/n while the picker is up: the request
  // waits BELOW `alpha-go`, and the marker names who waits on you — both rows.
  await released(rig, 0);
  await settleUntil(() => rig.children[1]!.held);
  await released(rig, 1);
  await settleUntil(() => stripText(rig.ui).includes('beta one') && stripText(rig.ui).includes('waiting for you'));
  const strip = stripText(rig.ui).split('\n');
  const taskRow = strip.find((r) => r.includes('beta one')) ?? '';
  const subRow = strip.find((r) => r.includes('alpha-go') && !r.includes('beta one')) ?? '';
  expect(taskRow).toContain('? waiting for you');
  expect(subRow).toContain('? waiting for you');
  // Enter lands on that request: the picker closes with no watch, and the request block —
  // the grandchild's y/n — takes the keyboard.
  await rig.ui.press('return');
  await settleUntil(() => frameOf(rig.ui).includes('Confirm write: run_command'));
  expect(frameOf(rig.ui)).not.toContain('Flow Assist · Work');
  rig.ui.app.unmount();
}, 20_000);
