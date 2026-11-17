// The work picker (`/work`, and its `work` key): the session's live subagents and
// background shells in one list (docs/usage.md). Enter opens what is under the cursor —
// a subagent's watch, a shell's output in the pager — and ctrl+d kills a shell after the
// picker's own y/n. The picker is one-shot: Esc closes it back to the chat. The real app
// on the scripted model; the pause before a parked request takes the keyboard is read
// from `askClock`, which the tests move.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askClock } from '../assistant/child-ask-guard.ts';
import { hostStateDir } from '../config/load.ts';
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
const pause = () => { clock.t += 700; };
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
// The tool results a request carried — what a subagent's answer reached it as.
const results = (req: { messages: { role: string; content?: unknown }[] } | undefined): string[] =>
  (req?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content).replace(/^OK: /, ''));

// A subagent the person starts: held at its first step, then its request of the kind.
const labelOf = (mark: string) => `${mark.toLowerCase()}-go`;
interface Kid { mark: string; kind: 'run' | 'ask' }
const requestOf = (kid: Kid, root: string) => (kid.kind === 'ask'
  ? { tool: 'ask_parent', args: { question: `Q-${kid.mark}?` } }
  : { tool: 'run_command', args: { command: `touch ${path.join(root, `${kid.mark}.txt`)}` } });
const scriptOf = (kid: Kid, root: string): Turn[] => [[{ hold: true as const }, requestOf(kid, root)], [{ text: `${kid.mark} settled` }]];

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

test('the picker opens on its key and shows both groups', async () => {
  const rig = await boot([{ mark: 'HYN', kind: 'run' }]);
  await rig.ui.press('F');
  await spawn(rig, 0);
  await shell(rig.ui, 'echo up; sleep 60 &', '○ sh-1');
  await openByKey(rig.ui);
  const frame = frameOf(rig.ui);
  // The two group headers, one row each.
  expect(frame).toContain('Subagents');
  expect(frame).toContain('Shells');
  expect(frame).toContain('hyn-go');
  expect(frame).toContain('sh-1 · echo up; sleep 60');
  expect(frame).toContain('running — this chat');
  // The key-caps hint at the bottom names the keys as glyphs.
  expect(frame).toContain('⏎ open');
  expect(frame).toContain('^d kill');
  // Esc closes it; /work opens the same panel again.
  await rig.ui.press('escape');
  await settleUntil(() => !frameOf(rig.ui).includes('Flow Assist · Work'));
  expect(frameOf(rig.ui)).not.toContain('Subagents');
  await openByCommand(rig.ui);
  expect(frameOf(rig.ui)).toContain('Subagents');
  expect(frameOf(rig.ui)).toContain('hyn-go');
  rig.ui.app.unmount();
}, 20_000);

test('enter opens what is under the cursor', async () => {
  const rig = await boot([{ mark: 'HYN', kind: 'run' }]);
  await rig.ui.press('F');
  await spawn(rig, 0);
  await shell(rig.ui, 'echo up; sleep 60 &', '○ sh-1');
  await openByKey(rig.ui);
  // The subagent row: the picker closes and its watch is on, Esc back to the chat.
  await rig.ui.press('down');
  await rig.ui.press('return');
  await settleUntil(() => !frameOf(rig.ui).includes('Flow Assist · Work'));
  expect(frameOf(rig.ui)).toMatch(/Flow Assist \(scripted\) · hyn-go/);
  await rig.ui.press('escape');
  await settleUntil(() => frameOf(rig.ui).includes('○ sh-1'));
  // The shell row: its output pager is up over the kept tail.
  await openByCommand(rig.ui);
  await rig.ui.press('down', 'down', 'down');
  await rig.ui.press('return');
  await settleUntil(() => frameOf(rig.ui).includes('│ up'));
  expect(frameOf(rig.ui)).toContain('│ up');
  rig.ui.app.unmount();
}, 20_000);

test('ctrl+d kills a shell after its own y/n', async () => {
  const rig = await boot();
  await rig.ui.press('F');
  await shell(rig.ui, 'sleep 60 &', '○ sh-1');
  await openByKey(rig.ui);
  await rig.ui.press('down', 'down', 'down');
  await rig.ui.backend.press({ name: 'd', ctrl: true });
  await settle();
  expect(frameOf(rig.ui)).toMatch(/kill sh-1\? y yes · n no/);
  // `n` cancels: the job is alive and the row is back to its state.
  await rig.ui.press('n');
  await settleUntil(() => !frameOf(rig.ui).includes('kill sh-1'));
  expect(frameOf(rig.ui)).toContain('sh-1 · sleep 60');
  expect(frameOf(rig.ui)).toContain('running — this chat');
  // ctrl+d again, `y`: the job ends through the registry's own kill, and the row follows.
  await rig.ui.backend.press({ name: 'd', ctrl: true });
  await settleUntil(() => frameOf(rig.ui).includes('kill sh-1'));
  await rig.ui.press('y');
  await settleUntil(() => frameOf(rig.ui).includes('killed (person) — this chat'));
  expect(frameOf(rig.ui)).toContain('killed (person) — this chat');
  // Ctrl+D was the panel's, not the exit arm's: nothing armed, nothing exited.
  expect(frameOf(rig.ui)).not.toContain('^d again');
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
  await rig.ui.press('down');
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
