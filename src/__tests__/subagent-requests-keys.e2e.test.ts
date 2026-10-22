// Which request each key reaches when several are up at once: the session's own y/n and
// question, a subagent's y/n and a subagent's question (AGENTS.md (subagent y/n), (agent
// tree), (watching a child)). A holder of the keys — the tree cursor, a watch, the pager,
// the `/context` panel, the session picker, a docked plugin panel — keeps them from a
// subagent's request, which is offered again, armed afresh, once the holder is gone. The
// real app on the scripted model; the pause before an answer counts is read from
// `askClock`, which the tests move.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askClock } from '../assistant/child-ask-guard.ts';
import { NO_ANSWER } from '../assistant/conversation.ts';
import { FLOWTTY_VERSION, HOST_API } from '../version';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
const realNow = askClock.now;
const clock = { t: 10_000 };
afterEach(() => { globalThis.fetch = realFetch; askClock.now = realNow; });

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const rowsOf = (ui: UI) => frameOf(ui).split('\n');
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
const pause = () => { clock.t += 700; };
const BLOCK = 'Confirm write: run_command';
const title = (label: string) => `? from «${label}»`;
const notice = (label: string) => `a question from «${label}» waits — clear the field to answer it`;
const ynNotice = (label: string) => `${label} waits for a y/n — clear the line to answer`;
const OWN_Q = 'Pick one?';
const results = (req: { messages: { role: string; content?: unknown }[] } | undefined): string[] =>
  (req?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content).replace(/^OK: /, ''));

type Kind = 'yn' | 'ask' | 'idle';
interface Kid { mark: string; kind: Kind; turn?: unknown[] }
// A subagent: held at its first step, then the request of its kind, then a closing text.
const scriptOf = (kid: Kid, root: string) => {
  const request = kid.kind === 'yn'
    ? { tool: 'run_command', args: { command: `touch ${path.join(root, `${kid.mark}.txt`)}` } }
    : kid.kind === 'ask' ? { tool: 'ask_parent', args: { question: `Q-${kid.mark}?` } } : { text: `${kid.mark} idle` };
  return [kid.turn ?? [{ hold: true }, request], [{ text: `${kid.mark} settled` }]];
};
const labelOf = (mark: string) => `${mark.toLowerCase()}-go`;

async function boot(kids: Kid[], opts: { main?: any[][]; root?: string; extra?: Record<string, unknown>; boot?: Record<string, unknown> } = {}) {
  clock.t = 10_000;
  askClock.now = () => clock.t;
  const root = opts.root ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-reqkeys-')));
  const model = new ScriptedModel();
  const children = kids.map((kid) => {
    const child = model.when((req) => firstUser(req).includes(kid.mark));
    child.script(...scriptOf(kid, root) as never);
    return child;
  });
  if (opts.main) model.script(...opts.main as never);
  const ui = await bootApp(model, 140, 40, undefined, { sessions: { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fa-reqkeys-s-')) }, shell: { roots: [root], timeoutMs: 20000 }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false }, ...opts.extra }, { toastMs: 10_000, ...opts.boot });
  await ui.press('F');
  return { ui, model, children, root, kids, file: (mark: string) => path.join(root, `${mark}.txt`) };
}
type Rig = Awaited<ReturnType<typeof boot>>;
const spawn = async (rig: Rig, i: number) => {
  await ask(rig.ui, `/subagent ${rig.kids[i]!.mark} go`);
  await settleUntil(() => rig.children[i]!.held);
};
// The request of a kind is on screen (the y/n block or the question's block).
const shows = (ui: UI, kid: Kid) => frameOf(ui).includes(kid.kind === 'yn' ? `⚠ ${labelOf(kid.mark)} · ${BLOCK}` : title(labelOf(kid.mark)));
const answered = (rig: Rig, i: number): boolean => rig.kids[i]!.kind === 'yn' ? fs.existsSync(rig.file(rig.kids[i]!.mark)) : rig.children[i]!.requests.length >= 2;
const askedOf = (rig: Rig, i: number) => results(rig.children[i]!.requests[1]);
// The turn of a subagent that wants its request: the request is made once released.
const released = async (rig: Rig, i: number) => {
  rig.children[i]!.release();
  await settleUntil(() => rig.children[i]!.requests.length >= 1 && !rig.children[i]!.held);
  await settle(10);
};

// ─── the holders of the keys ─────────────────────────────────────────────────────────
// Each opens over a running (held) subagent, before its request is made, and is closed
// by the keys it takes to get back to the conversation.
interface Holder { name: string; open: (rig: Rig) => Promise<void>; close: (rig: Rig) => Promise<void>; kids: (k: Kid) => Kid[]; main?: any[][] }
const escapes = (n: number) => async (rig: Rig) => { for (let i = 0; i < n; i++) await rig.ui.press('escape'); };
const SEQ = [[{ tool: 'run_command', args: { command: 'seq 1 300' } }], [{ text: 'Counted.' }]];
const holders: Holder[] = [
  { name: 'the tree cursor on a row', kids: (k) => [k], open: async (rig) => { await rig.ui.press('down'); }, close: escapes(1) },
  { name: 'the watch of another subagent', kids: (k) => [k, { mark: 'BYST', kind: 'idle' }], open: async (rig) => { await rig.ui.press('down', 'down', 'return'); await settleUntil(() => frameOf(rig.ui).includes('Esc')); }, close: escapes(2) },
  { name: 'the /context panel', kids: (k) => [k], open: async (rig) => { await ask(rig.ui, '/context'); await settleUntil(() => frameOf(rig.ui).includes('on screen')); }, close: escapes(1) },
  { name: 'the session picker', kids: (k) => [k], open: async (rig) => { rig.ui.backend.press({ name: 's', ctrl: true }); await settle(4); }, close: escapes(2) /* the first clears the filter the letters made */ },
  {
    name: 'a pager over the chat', kids: (k) => [k], main: SEQ,
    open: async (rig) => {
      const rows = rowsOf(rig.ui);
      const at = rows.findIndex((r) => r.includes('seq 1 300 ·'));
      const x = rows[at]!.indexOf('seq 1 300 ·');
      rig.ui.backend.mouse('down', x, at);
      rig.ui.backend.mouse('up', x, at);
      await settle(6);
      expect(frameOf(rig.ui)).toContain('the wheel scroll · Esc close');
    },
    close: escapes(1),
  },
];
// Before the subagents are started, the pager's block exists: the session runs a command.
async function prepare(rig: Rig, holder: Holder) {
  if (!holder.main) return;
  await ask(rig.ui, 'count');
  await settleUntil(() => frameOf(rig.ui).includes(BLOCK));
  await rig.ui.press('y');
  await settleUntil(() => frameOf(rig.ui).includes('Counted.'));
  await settle(6);
}

for (const holder of holders) {
  for (const kind of ['yn', 'ask'] as const) {
    test(`${holder.name} over a subagent's ${kind === 'yn' ? 'y/n' : 'question'}: its keys stay the holder's; once it is gone the request is there, armed afresh, and the answer counts after the pause`, async () => {
      const kid: Kid = { mark: kind === 'yn' ? 'HYN' : 'HASK', kind };
      const rig = await boot(holder.kids(kid), { main: holder.main });
      await prepare(rig, holder);
      await spawn(rig, 0);
      if (rig.kids.length > 1) await spawn(rig, 1);
      await holder.open(rig);
      await released(rig, 0);
      // Armed or not, a key meant for the holder is not an answer.
      pause();
      if (kind === 'yn') await rig.ui.press('y'); else await rig.ui.type('zz');
      await settle(4);
      expect(answered(rig, 0)).toBe(false);
      expect(rig.children[0]!.requests.length).toBe(1);
      expect(shows(rig.ui, kid)).toBe(false);
      await holder.close(rig);
      await settleUntil(() => shows(rig.ui, kid));
      // The key right after the holder went is a letter of the field, never an answer.
      if (kind === 'yn') await rig.ui.press('y'); else await rig.ui.press('z');
      await settle(4);
      expect(answered(rig, 0)).toBe(false);
      await rig.ui.press('backspace');
      await settleUntil(() => shows(rig.ui, kid));
      pause();
      if (kind === 'yn') {
        await rig.ui.press('y');
        await settleUntil(() => answered(rig, 0));
      } else {
        await rig.ui.type('late');
        await rig.ui.press('return');
        await settleUntil(() => answered(rig, 0));
        expect(askedOf(rig, 0)).toEqual(['The person answered: late']);
      }
      rig.ui.app.unmount();
    }, 20_000);
  }
}

// ─── the watch of the asking subagent ────────────────────────────────────────────────
test('the watch of the asking subagent draws its y/n; y counts only after the pause', async () => {
  const rig = await boot([{ mark: 'WYN', kind: 'yn' }]);
  await spawn(rig, 0);
  await rig.ui.press('down', 'return');
  await settleUntil(() => frameOf(rig.ui).includes('╭─ ƒ Flow Assist · '));
  await released(rig, 0);
  expect(frameOf(rig.ui)).toContain(BLOCK);
  await rig.ui.press('y');
  await settle(4);
  expect(answered(rig, 0)).toBe(false);
  pause();
  await rig.ui.press('y');
  await settleUntil(() => answered(rig, 0));
  rig.ui.app.unmount();
});

test('the watch of the asking subagent holds every other key: nothing is typed into the field under it', async () => {
  const rig = await boot([{ mark: 'WTYPE', kind: 'ask' }]);
  await spawn(rig, 0);
  await rig.ui.press('down', 'return');
  await settleUntil(() => frameOf(rig.ui).includes('╭─ ƒ Flow Assist · '));
  await released(rig, 0);
  pause();
  await rig.ui.press('tab');
  await rig.ui.press('up');
  await settle(4);
  expect(answered(rig, 0)).toBe(false);
  rig.ui.app.unmount();
});

// ─── a docked plugin panel ───────────────────────────────────────────────────────────
const MANIFEST = (name: string) => ({ name, version: '1.2.3', hostApi: HOST_API, flowtty: FLOWTTY_VERSION, description: `the ${name} plugin` });
function pluginDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-reqkeys-pl-'));
  const available = path.join(root, 'plugins-available');
  const enabled = path.join(root, 'plugins-enabled');
  fs.mkdirSync(available);
  fs.mkdirSync(enabled);
  return { root, available, enabled, trustFile: path.join(root, 'plugins.trusted.json') };
}
function jsPlugin(d: ReturnType<typeof pluginDirs>, name: string): string {
  const dir = path.join(d.available, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST(name)));
  fs.writeFileSync(path.join(dir, 'index.ts'), `export default ({ make }) => make('${name}', { keys: { ${name}Open: 'G' } });\n`);
  fs.symlinkSync(dir, path.join(d.enabled, name));
  return dir;
}

test('a docked plugin panel over a subagent\'s question: the panel keeps the keys, ^] closes it, and the question is there armed afresh', async () => {
  const d = pluginDirs();
  const good = jsPlugin(d, 'good');
  jsPlugin(d, 'other');
  fs.writeFileSync(d.trustFile, JSON.stringify({ firstStartDone: true, dirs: { [fs.realpathSync(d.enabled)]: { good: fs.realpathSync(good) } }, forgotten: {} }));
  const before = fs.readFileSync(d.trustFile, 'utf8');
  const rig = await boot([{ mark: 'PQ', kind: 'ask' }], { boot: { dirs: d, trustFile: d.trustFile, chatMode: 'panel' } });
  await spawn(rig, 0);
  rig.ui.backend.press({ name: ']', ctrl: true });
  await settle();
  await rig.ui.press(':');
  await rig.ui.type('plugins');
  await rig.ui.press('return');
  await settleUntil(() => frameOf(rig.ui).includes('Flow Assist · Plugins'));
  await released(rig, 0);
  expect(frameOf(rig.ui)).not.toContain(title(labelOf('PQ')));
  pause();
  await rig.ui.type('zz');
  await settle(4);
  expect(answered(rig, 0)).toBe(false);
  expect(frameOf(rig.ui)).toContain('Flow Assist · Plugins');
  expect(fs.readFileSync(d.trustFile, 'utf8')).toBe(before);
  rig.ui.backend.press({ name: ']', ctrl: true });
  await settle();
  expect(frameOf(rig.ui)).not.toContain('Flow Assist · Plugins');
  await settleUntil(() => shows(rig.ui, rig.kids[0]!));
  await rig.ui.press('z');
  await settle(4);
  expect(answered(rig, 0)).toBe(false);
  await rig.ui.press('backspace');
  await settleUntil(() => shows(rig.ui, rig.kids[0]!));
  pause();
  await rig.ui.type('ok');
  await rig.ui.press('return');
  await settleUntil(() => answered(rig, 0));
  expect(askedOf(rig, 0)).toEqual(['The person answered: ok']);
  rig.ui.app.unmount();
}, 60_000);

// ─── the session's own request arrives while a subagent's question is drawn ──────────
const OWN_ASK = [[{ hold: true }, { tool: 'ask_user', args: { questions: [{ question: OWN_Q, options: [{ label: 'A' }, { label: 'B' }] }] } }], [{ text: 'picked' }]];

async function ownOverDrawnQuestion() {
  const rig = await boot([{ mark: 'OVER', kind: 'ask' }], { main: OWN_ASK });
  await ask(rig.ui, 'go'); // the session's turn is held
  await settleUntil(() => rig.model.held);
  await spawn(rig, 0);
  await released(rig, 0);
  await settleUntil(() => shows(rig.ui, rig.kids[0]!));
  pause();
  await rig.ui.type('ab');
  await settle(4);
  expect(frameOf(rig.ui)).toContain('ab');
  return rig;
}

test('the session\'s question arriving over a drawn subagent question wins; a key already on its way does not answer it; the typed answer is kept', async () => {
  const rig = await ownOverDrawnQuestion();
  rig.model.release();
  await settleUntil(() => frameOf(rig.ui).includes(OWN_Q));
  expect(frameOf(rig.ui)).not.toContain(title(labelOf('OVER')));
  // The next key of the person's typing is not an answer to the question that just came.
  await rig.ui.press('1');
  await settle(4);
  expect(frameOf(rig.ui)).toContain(OWN_Q);
  pause();
  await rig.ui.press('1');
  await settleUntil(() => !frameOf(rig.ui).includes(OWN_Q));
  // The subagent's question is back with what was typed; its answer needs the pause again.
  await settleUntil(() => shows(rig.ui, rig.kids[0]!));
  expect(frameOf(rig.ui)).toContain('ab');
  await rig.ui.press('return'); // a key right behind the first answer's must not send 'ab'
  await settle(4);
  expect(answered(rig, 0)).toBe(false);
  pause();
  await rig.ui.type('c');
  await rig.ui.press('return');
  await settleUntil(() => answered(rig, 0));
  expect(askedOf(rig, 0)).toEqual(['The person answered: abc']);
  rig.ui.app.unmount();
}, 20_000);

test('the session\'s y/n arriving over a drawn subagent question is armed too; the typed answer is kept', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-reqkeys-own-')));
  const main = [[{ hold: true }, { tool: 'run_command', args: { command: `touch ${path.join(root, 'own.txt')}` } }], [{ text: 'done' }]];
  const rig = await boot([{ mark: 'OVERYN', kind: 'ask' }], { main, root });
  await ask(rig.ui, 'go');
  await settleUntil(() => rig.model.held);
  await spawn(rig, 0);
  await released(rig, 0);
  await settleUntil(() => shows(rig.ui, rig.kids[0]!));
  pause();
  await rig.ui.type('yy');
  rig.model.release();
  await settleUntil(() => frameOf(rig.ui).includes(BLOCK));
  await rig.ui.press('y');
  await settle(4);
  expect(fs.existsSync(path.join(root, 'own.txt'))).toBe(false);
  pause();
  await rig.ui.press('y');
  await settleUntil(() => fs.existsSync(path.join(root, 'own.txt')));
  await settleUntil(() => shows(rig.ui, rig.kids[0]!));
  expect(frameOf(rig.ui)).toContain('yy');
  expect(answered(rig, 0)).toBe(false);
  rig.ui.app.unmount();
}, 20_000);

// ─── a question appearing while the person types ─────────────────────────────────────
test('a draft that stays after the question came: clearing the field draws the block, and the key right after the clearing is a letter, however long the question has been up', async () => {
  const rig = await boot([{ mark: 'DRAFT', kind: 'ask' }]);
  await spawn(rig, 0);
  await rig.ui.type('hi'); // the draft, before the request
  await released(rig, 0);
  await settleUntil(() => frameOf(rig.ui).includes(notice(labelOf('DRAFT'))));
  expect(shows(rig.ui, rig.kids[0]!)).toBe(false);
  pause();
  pause();
  await rig.ui.press('backspace', 'backspace'); // the second key clears the field
  await settleUntil(() => shows(rig.ui, rig.kids[0]!));
  await rig.ui.press('q');
  await settle(4);
  expect(answered(rig, 0)).toBe(false);
  expect(frameOf(rig.ui)).toContain(notice(labelOf('DRAFT'))); // the q went to the field
  await rig.ui.press('backspace');
  await settleUntil(() => shows(rig.ui, rig.kids[0]!));
  pause();
  await rig.ui.type('now');
  await rig.ui.press('return');
  await settleUntil(() => answered(rig, 0));
  expect(askedOf(rig, 0)).toEqual(['The person answered: now']);
  rig.ui.app.unmount();
}, 20_000);

// ─── commands typed beside a question ────────────────────────────────────────────────
test('with a draft, a /subagent tell typed beside a waiting question is a command of the field: it is sent and the question still waits', async () => {
  const rig = await boot([{ mark: 'CMDA', kind: 'ask' }, { mark: 'CMDB', kind: 'idle' }]);
  await spawn(rig, 0);
  await rig.ui.type(`/subagent tell ${labelOf('CMDA')} hello there`);
  await released(rig, 0);
  await settleUntil(() => frameOf(rig.ui).includes(notice(labelOf('CMDA'))));
  await rig.ui.press('return');
  await settleUntil(() => frameOf(rig.ui).includes('your message reaches it at its next step'));
  // The command's text was not the answer: the question still waits.
  expect(answered(rig, 0)).toBe(false);
  await settleUntil(() => shows(rig.ui, rig.kids[0]!));
  rig.ui.app.unmount();
}, 20_000);

test('a /subagent stop typed before the question came ends the subagent: the draft rule keeps its text out of the answer', async () => {
  const rig = await boot([{ mark: 'CMDS', kind: 'ask' }]);
  await spawn(rig, 0);
  await rig.ui.type(`/subagent stop ${labelOf('CMDS')}`);
  await released(rig, 0);
  await settleUntil(() => frameOf(rig.ui).includes(notice(labelOf('CMDS'))));
  await rig.ui.press('return');
  await settleUntil(() => frameOf(rig.ui).includes('◆ cmds-go stopped'));
  expect(frameOf(rig.ui)).not.toContain(title(labelOf('CMDS')));
  expect(rig.children[0]!.requests.length).toBe(1); // the wait ended as a stop, not an answer
  rig.ui.app.unmount();
}, 20_000);

test('while the question\'s block is drawn, a line starting with / is the answer\'s text', async () => {
  const rig = await boot([{ mark: 'SLASH', kind: 'ask' }]);
  await spawn(rig, 0);
  await released(rig, 0);
  await settleUntil(() => shows(rig.ui, rig.kids[0]!));
  pause();
  await rig.ui.type(`/subagent stop ${labelOf('SLASH')}`);
  await rig.ui.press('return');
  await settleUntil(() => answered(rig, 0));
  expect(askedOf(rig, 0)).toEqual([`The person answered: /subagent stop ${labelOf('SLASH')}`]);
  expect(frameOf(rig.ui)).not.toContain('stopped');
  rig.ui.app.unmount();
}, 20_000);

test('the session\'s own ask_user block takes a line starting with / as the answer\'s text too: neither block refuses one', async () => {
  const rig = await boot([], { main: OWN_ASK });
  await ask(rig.ui, 'go');
  await settleUntil(() => rig.model.held);
  rig.model.release();
  await settleUntil(() => frameOf(rig.ui).includes(OWN_Q));
  await rig.ui.type('/subagent stop nobody');
  await rig.ui.press('return');
  await settleUntil(() => rig.model.requests.length >= 2);
  expect(results(rig.model.requests[1]!).join('\n')).toContain('(their own words) /subagent stop nobody');
  rig.ui.app.unmount();
}, 20_000);

// ─── the keys of the list and of the app while a question block is drawn ─────────────
// A subagent's question and the session's own take them alike: swallowed, nothing opens,
// nothing is answered; Esc dismisses; Ctrl+C is the app's exit arm (or, with a turn to
// stop, the stop of that turn).
type Blocked = { name: string; open: () => Promise<{ ui: UI; still: () => boolean; settled: () => boolean; rig: Rig }> };
const blocks: Blocked[] = [
  {
    name: 'a subagent\'s question',
    open: async () => {
      const rig = await boot([{ mark: 'KEYC', kind: 'ask' }]);
      await spawn(rig, 0);
      await released(rig, 0);
      await settleUntil(() => shows(rig.ui, rig.kids[0]!));
      pause();
      return { ui: rig.ui, rig, still: () => shows(rig.ui, rig.kids[0]!), settled: () => answered(rig, 0) };
    },
  },
  {
    name: 'the session\'s own question',
    open: async () => {
      const rig = await boot([], { main: OWN_ASK });
      await ask(rig.ui, 'go');
      await settleUntil(() => rig.model.held);
      rig.model.release();
      await settleUntil(() => frameOf(rig.ui).includes(OWN_Q));
      pause();
      return { ui: rig.ui, rig, still: () => frameOf(rig.ui).includes(OWN_Q), settled: () => rig.model.requests.length >= 2 };
    },
  },
];
for (const b of blocks) {
  test(`${b.name}: ↑/↓, Tab, ⇧⇥ and the sessions key change nothing and open nothing; Esc dismisses`, async () => {
    const { ui, still, settled } = await b.open();
    for (const key of [{ name: 'up' }, { name: 'down' }, { name: 'tab' }, { name: 'tab', shift: true }, { name: 's', ctrl: true }]) {
      ui.backend.press(key);
      await settle(3);
      expect(still()).toBe(true);
      expect(settled()).toBe(false);
      expect(frameOf(ui)).not.toContain('Sessions ·');
    }
    await ui.press('escape');
    await settleUntil(settled);
    expect(still()).toBe(false);
    ui.app.unmount();
  }, 20_000);
}

test('Ctrl+C over a subagent\'s question arms the exit and leaves the question up; another key disarms it', async () => {
  const { ui, still, settled } = await blocks[0]!.open();
  ui.backend.press({ name: 'c', ctrl: true });
  await settle(4);
  expect(frameOf(ui)).toContain('^c again to exit');
  expect(still()).toBe(true);
  expect(settled()).toBe(false);
  expect(ui.exits()).toBe(0);
  await ui.press('down');
  expect(frameOf(ui)).not.toContain('^c again to exit');
  expect(still()).toBe(true);
  ui.app.unmount();
});

test('Ctrl+C over the session\'s own question dismisses it and stops the turn, as it always does', async () => {
  const { ui, still, rig } = await blocks[1]!.open();
  ui.backend.press({ name: 'c', ctrl: true });
  await settleUntil(() => !still());
  expect(frameOf(ui)).not.toContain('^c again to exit');
  expect(ui.exits()).toBe(0);
  void rig;
  ui.app.unmount();
});

test('the keys of a question block that came a moment ago are the field\'s: the sessions key opens the picker, Esc closes it and the block is armed afresh', async () => {
  const rig = await boot([{ mark: 'FRESH', kind: 'ask' }]);
  await spawn(rig, 0);
  await released(rig, 0);
  await settleUntil(() => shows(rig.ui, rig.kids[0]!));
  rig.ui.backend.press({ name: 's', ctrl: true });
  await settle(4);
  expect(frameOf(rig.ui)).toContain('Sessions ·');
  expect(shows(rig.ui, rig.kids[0]!)).toBe(false);
  expect(answered(rig, 0)).toBe(false);
  await rig.ui.press('escape');
  await settleUntil(() => shows(rig.ui, rig.kids[0]!));
  await rig.ui.press('escape'); // right after the picker: still unarmed, the field's Esc
  await settle(4);
  expect(answered(rig, 0)).toBe(false);
  rig.ui.app.unmount();
});

// ─── one subagent cannot hold both kinds of request ──────────────────────────────────
// A turn's tool calls run one after another: the second request is made only once the first
// is answered, so it is never on screen beside it.
for (const first of ['yn', 'ask'] as const) {
  test(`a subagent's ${first === 'yn' ? 'y/n then question' : 'question then y/n'} in one turn: the second never shows while the first is up`, async () => {
    const mark = first === 'yn' ? 'BOTHYN' : 'BOTHQ';
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-reqkeys-both-')));
    const yn = { tool: 'run_command', args: { command: `touch ${path.join(root, `${mark}.txt`)}` } };
    const q = { tool: 'ask_parent', args: { question: `Q-${mark}?` } };
    const kid: Kid = { mark, kind: first, turn: [{ hold: true }, ...(first === 'yn' ? [yn, q] : [q, yn])] };
    const rig = await boot([kid], { root });
    await spawn(rig, 0);
    await released(rig, 0);
    const ynShown = () => frameOf(rig.ui).includes(BLOCK);
    const qShown = () => frameOf(rig.ui).includes(title(labelOf(mark)));
    await settleUntil(() => (first === 'yn' ? ynShown() : qShown()));
    await settle(10);
    expect(first === 'yn' ? qShown() : ynShown()).toBe(false);
    pause();
    if (first === 'yn') await rig.ui.press('y'); else { await rig.ui.type('one'); await rig.ui.press('return'); }
    // The second is drawn only now, and not answered by anything typed before it.
    await settleUntil(() => (first === 'yn' ? qShown() : ynShown()));
    expect(first === 'yn' ? ynShown() : qShown()).toBe(false);
    expect(rig.children[0]!.requests.length).toBe(1);
    pause();
    if (first === 'yn') { await rig.ui.type('two'); await rig.ui.press('return'); } else await rig.ui.press('y');
    await settleUntil(() => rig.children[0]!.requests.length >= 2);
    expect(fs.existsSync(rig.file(mark))).toBe(true);
    rig.ui.app.unmount();
  }, 20_000);
}

// ─── two subagents, one y/n and one question ─────────────────────────────────────────
for (const [older, newer] of [['yn', 'ask'], ['ask', 'yn']] as const) {
  test(`two subagents, the older ${older === 'yn' ? 'y/n' : 'question'} and the newer ${newer === 'yn' ? 'y/n' : 'question'}: the older is drawn first, the other after it is answered`, async () => {
    const rig = await boot([{ mark: 'OLDER', kind: older }, { mark: 'NEWER', kind: newer }]);
    await spawn(rig, 0);
    await spawn(rig, 1);
    await released(rig, 0);
    await settleUntil(() => shows(rig.ui, rig.kids[0]!));
    await released(rig, 1);
    await settle(10);
    expect(shows(rig.ui, rig.kids[0]!)).toBe(true);
    expect(shows(rig.ui, rig.kids[1]!)).toBe(false);
    // A key of the older's answer is nothing of the newer's.
    pause();
    if (older === 'yn') await rig.ui.press('y'); else { await rig.ui.type('first'); await rig.ui.press('return'); }
    await settleUntil(() => answered(rig, 0));
    await settleUntil(() => shows(rig.ui, rig.kids[1]!));
    expect(answered(rig, 1)).toBe(false);
    // The pause starts when the newer's block comes: the key right behind is a letter.
    await rig.ui.press(newer === 'yn' ? 'y' : 'z');
    await settle(4);
    expect(answered(rig, 1)).toBe(false);
    await rig.ui.press('backspace');
    await settleUntil(() => shows(rig.ui, rig.kids[1]!));
    pause();
    if (newer === 'yn') await rig.ui.press('y'); else { await rig.ui.type('second'); await rig.ui.press('return'); }
    await settleUntil(() => answered(rig, 1));
    if (older === 'ask') expect(askedOf(rig, 0)).toEqual(['The person answered: first']);
    if (newer === 'ask') expect(askedOf(rig, 1)).toEqual(['The person answered: second']);
    rig.ui.app.unmount();
  }, 20_000);
}

// ─── the session's own request under a holder of the keys ────────────────────────────
// The session's own y/n and question are drawn over the picker and the /context panel and
// take their first key at once (the picker and the panel give way to them); over the tree
// cursor they are armed: the answer counts after the pause.
const holdersOfOwn = [
  { name: 'the session picker', armed: false, open: async (rig: Rig) => { rig.ui.backend.press({ name: 's', ctrl: true }); await settle(4); } },
  { name: 'the /context panel', armed: false, open: async (rig: Rig) => { await ask(rig.ui, '/context'); await settle(4); } },
  { name: 'the tree cursor', armed: true, open: async (rig: Rig) => { await rig.ui.press('down'); } },
];
for (const holder of holdersOfOwn) {
  for (const kind of ['yn', 'ask'] as const) {
    test(`the session's own ${kind === 'yn' ? 'y/n' : 'question'} arriving over ${holder.name}: drawn and answered ${holder.armed ? 'after the pause' : 'by the first key'}`, async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-reqkeys-own-')));
      const own = path.join(root, 'own.txt');
      const main = kind === 'yn' ? [[{ hold: true }, { tool: 'run_command', args: { command: `touch ${own}` } }], [{ text: 'done' }]] : OWN_ASK;
      const rig = await boot(holder.armed ? [{ mark: 'ROW', kind: 'idle' }] : [], { main, root });
      if (holder.armed) await spawn(rig, 0);
      await ask(rig.ui, 'go');
      await settleUntil(() => rig.model.held);
      await holder.open(rig);
      rig.model.release();
      await settleUntil(() => frameOf(rig.ui).includes(kind === 'yn' ? BLOCK : OWN_Q));
      const key = kind === 'yn' ? 'y' : '1';
      const done = () => kind === 'yn' ? fs.existsSync(own) : rig.model.requests.some((r) => results(r).join('\n').includes('The user answered'));
      if (holder.armed) {
        await rig.ui.press(key);
        await settle(4);
        expect(done()).toBe(false);
        pause();
      }
      await rig.ui.press(key);
      await settleUntil(done);
      rig.ui.app.unmount();
    }, 20_000);
  }
}
