// `/subagent` (and `/sub`): the person starts a read-only job beside the chat, lists the
// jobs of the conversation and stops one (AGENTS.md (subagent command)). The real app on
// the scripted model; a child's requests are told from the session's by the prompt it
// was given, and held with `{ hold: true }` until the test lets them go.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptedConfigPath, hostStateDir, resetSessionConfig, unguardConfigFiles } from '../config/load.ts';
import { ScriptedModel, bootApp, firstUser, handoff, settle } from './helpers/scripted';
import { listSessions } from '../assistant/sessions.ts';
import { listTree } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  unguardConfigFiles();
  resetSessionConfig();
  fs.rmSync(path.join(hostStateDir(), 'config.local.json'), { force: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
});

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const hintRow = (frame: string) => frame.split('\n').find((r) => r.includes('history · wheel')) ?? '';
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
// A refused command stays in the field to be fixed: this takes it out.
async function wipe(ui: UI, text: string) { for (let i = 0; i < text.length; i++) ui.backend.press({ name: 'backspace' }); await settle(); }
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-subagent-'));

// A booted chat, open, wide enough that the hint row keeps its last cell. The model's own
// script answers the session; `child` takes the requests whose first user message holds
// `mark`. No follow-up turn reads a result, so the session's script stays what the test wrote.
async function chat(mark: string, ...turns: Parameters<ScriptedModel['script']>) {
  const dir = dirOf();
  const model = new ScriptedModel();
  const child = model.when((req) => firstUser(req).includes(mark));
  child.script(...turns);
  const ui = await bootApp(model, 140, 34, undefined, { sessions: { dir }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: 10_000 });
  await ui.press('F');
  return { dir, model, child, ui };
}

// As `chat`, with one scripted child for each mark.
async function chatWith(marks: string[]) {
  const dir = dirOf();
  const model = new ScriptedModel();
  const children = marks.map((mark) => {
    const child = model.when((req) => firstUser(req).includes(mark));
    child.script([{ hold: true }, { text: `${mark} said it` }]);
    return child;
  });
  const ui = await bootApp(model, 140, 34, undefined, { sessions: { dir }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: 10_000 });
  await ui.press('F');
  return { dir, model, children, ui };
}

test('a held subagent runs while the person sends a message and gets its answer; the hint row counts it; its answer is a row', async () => {
  const { model, child, ui } = await chat('FIND-ME', [{ hold: true }, { text: 'It is in the third file.' }]);
  model.script([{ text: 'Hi there.' }]);
  await ask(ui, '/subagent FIND-ME the failing test');
  await settleUntil(() => child.held);
  expect(frameOf(ui)).toContain('subagent «find-me-the» started');
  await ask(ui, 'hello');
  await settleUntil(() => frameOf(ui).includes('Hi there.'));
  expect(frameOf(ui)).toContain('Hi there.');
  expect(hintRow(frameOf(ui))).toContain('1 in background');
  child.release();
  await settleUntil(() => frameOf(ui).includes('◆ find-me-the finished:'));
  expect(frameOf(ui)).toContain('◆ find-me-the finished:');
  expect(frameOf(ui)).toContain('It is in the third file.');
  await settleUntil(() => !frameOf(ui).includes('in background'));
  expect(frameOf(ui)).not.toContain('in background');
  ui.app.unmount();
});

test('/sub is the same command', async () => {
  const { child, ui } = await chat('SHORT-ONE', [{ hold: true }, { text: 'short answer' }]);
  await ask(ui, '/sub SHORT-ONE go');
  await settleUntil(() => child.held);
  expect(frameOf(ui)).toContain('subagent «short-one-go» started');
  child.release();
  await settleUntil(() => frameOf(ui).includes('◆ short-one-go finished:'));
  expect(frameOf(ui)).toContain('short answer');
  expect(child.requests).toHaveLength(1);
  ui.app.unmount();
});

test('the prompt reaches the model as written: its spacing and line breaks are kept', async () => {
  const { child, ui } = await chat('KEEP-ALPHA', [{ text: 'ok' }]);
  await ui.type('/subagent KEEP-ALPHA  beta');
  ui.backend.press({ name: 'return', shift: true });
  await ui.type('gamma');
  await ui.press('return');
  await settleUntil(() => child.requests.length === 1);
  expect(firstUser(child.requests[0]!)).toBe('KEEP-ALPHA  beta\ngamma');
  ui.app.unmount();
});

test('the listing shows the job running, then done with its duration; nothing is listed before, and a name that is not running is a line', async () => {
  const { child, ui } = await chat('LIST-ME', [{ hold: true }, { text: 'listed' }]);
  await ask(ui, '/subagent');
  await settleUntil(() => frameOf(ui).includes('no subagents here'));
  expect(frameOf(ui)).toContain('no subagents here');
  await ask(ui, '/subagent LIST-ME now');
  await settleUntil(() => child.held);
  await ask(ui, '/subagent');
  await settleUntil(() => /1 · list-me-now · working/.test(frameOf(ui)));
  expect(frameOf(ui)).toMatch(/1 · list-me-now · working · (<1s|\d+s)/);
  child.release();
  await settleUntil(() => frameOf(ui).includes('◆ list-me-now finished:'));
  await settle(6);
  await ask(ui, '/subagent');
  await settleUntil(() => /list-me-now · done · (<1s|\d+s)/.test(frameOf(ui)));
  expect(frameOf(ui)).toMatch(/list-me-now · done · (<1s|\d+s)/);
  // A name that is not running is a line, not a stop.
  await ask(ui, '/subagent stop nobody');
  await settleUntil(() => frameOf(ui).includes('no running subagent'));
  expect(frameOf(ui)).toContain('no running subagent «nobody»');
  ui.app.unmount();
});

test('stop ends it with the stopped row and exactly one toast', async () => {
  const { child, ui } = await chat('STOP-ME', [{ hold: true }, { text: 'never said' }]);
  await ask(ui, '/subagent STOP-ME please');
  await settleUntil(() => child.held);
  // Every distinct line of a toast the person was shown, from the start to well past the end.
  const toasts = new Set<string>();
  const watch = () => { for (const t of frameOf(ui).match(/(?:■ [\w-]+ stopped|⏳ [\w-]+ done|⚠ [\w-]+ failed)/g) ?? []) toasts.add(t); };
  await ask(ui, '/subagent');
  await settleUntil(() => /1 · stop-me-please · working/.test(frameOf(ui)));
  await ask(ui, '/subagent stop 1');
  for (let i = 0; i < 60; i++) { await settle(1); watch(); }
  expect(frameOf(ui)).toContain('◆ stop-me-please stopped:');
  expect(frameOf(ui)).toContain('nothing said yet');
  expect([...toasts]).toEqual(['■ stop-me-please stopped']);
  // A second stop finds nothing running.
  await ask(ui, '/subagent stop stop-me-please');
  await settleUntil(() => frameOf(ui).includes('no running subagent'));
  expect(frameOf(ui)).toContain('no running subagent «stop-me-please»');
  ui.app.unmount();
});

test('a stop number is read against the listing the person saw: a job that ended since does not shift the others', async () => {
  const { children: [a, b, c], ui } = await chatWith(['NUM-AAA', 'NUM-BBB', 'NUM-CCC']);
  // No listing printed yet: a number names nothing.
  await ask(ui, '/subagent stop 1');
  await settleUntil(() => frameOf(ui).includes('no running subagent numbered 1'));
  expect(frameOf(ui)).toContain('no running subagent numbered 1');
  await wipe(ui, '/subagent stop 1');
  await ask(ui, '/subagent NUM-AAA one');
  await ask(ui, '/subagent NUM-BBB two');
  await ask(ui, '/subagent NUM-CCC three');
  await settleUntil(() => a!.held && b!.held && c!.held);
  await ask(ui, '/subagent');
  await settleUntil(() => /3 · num-ccc-three/.test(frameOf(ui)));
  expect(frameOf(ui)).toMatch(/2 · num-bbb-two/);
  a!.release();
  await settleUntil(() => frameOf(ui).includes('◆ num-aaa-one finished:'));
  // The listing said 2 is b: b stops, c goes on.
  await ask(ui, '/subagent stop 2');
  await settleUntil(() => frameOf(ui).includes('◆ num-bbb-two stopped:'));
  expect(frameOf(ui)).toContain('◆ num-bbb-two stopped:');
  expect(frameOf(ui)).not.toContain('num-ccc-three stopped');
  // Number 1 was a, which has ended: refused, and c is untouched.
  await ask(ui, '/subagent stop 1');
  await settleUntil(() => frameOf(ui).includes('no running subagent numbered 1'));
  expect(frameOf(ui)).toContain('no running subagent numbered 1');
  expect(frameOf(ui)).not.toContain('num-ccc-three stopped');
  c!.release();
  await settleUntil(() => frameOf(ui).includes('◆ num-ccc-three finished:'));
  expect(frameOf(ui)).toContain('NUM-CCC said it');
  ui.app.unmount();
});

test('--with-context hands the summary to the child, and never the history', async () => {
  const { model, child, ui } = await chat('WITH-CTX', [{ text: 'used it' }]);
  model.script([{ text: 'Sure.' }], [{ text: handoff('SUMMARY-MARK the goal') }], [{ text: 'Noted.' }]);
  await ask(ui, 'an earlier question about HISTORY-WORD');
  await settleUntil(() => frameOf(ui).includes('Sure.'));
  await ask(ui, '/compact');
  await settleUntil(() => frameOf(ui).includes('── compacted'));
  // The conversation goes on after its summary: its history holds a word the summary lacks.
  await ask(ui, 'a later question about POST-WORD');
  await settleUntil(() => frameOf(ui).includes('Noted.'));
  await ask(ui, '/subagent --with-context WITH-CTX carry on');
  await settleUntil(() => child.requests.length === 1);
  const sent = JSON.stringify(child.requests[0]);
  expect(sent).toContain('SUMMARY-MARK');
  expect(sent).not.toContain('HISTORY-WORD');
  expect(sent).not.toContain('POST-WORD');
  // The flag is not part of the prompt the child is given.
  expect(firstUser(child.requests[0]!)).toBe('WITH-CTX carry on');
  ui.app.unmount();
});

test('--with-context with no summary starts nothing and says why', async () => {
  const { model, ui } = await chat('NO-SUMMARY', [{ text: 'should not run' }]);
  await ask(ui, '/subagent --with-context NO-SUMMARY anyway');
  await settleUntil(() => frameOf(ui).includes('no summary to hand over yet'));
  expect(frameOf(ui)).toContain('no summary to hand over yet — /compact makes one, or start it without --with-context');
  await settle(10);
  expect(model.requests).toHaveLength(0);
  await wipe(ui, '/subagent --with-context NO-SUMMARY anyway');
  await ask(ui, '/subagent');
  await settleUntil(() => frameOf(ui).includes('no subagents here'));
  expect(frameOf(ui)).toContain('no subagents here');
  ui.app.unmount();
});

test('--auto is refused with the reason, and nothing starts', async () => {
  const { model, ui } = await chat('AUTO-ONE', [{ text: 'should not run' }]);
  await ask(ui, '/subagent --auto AUTO-ONE fix it');
  await settleUntil(() => frameOf(ui).includes('needs writes'));
  expect(frameOf(ui)).toContain('/subagent --auto needs writes, which a subagent cannot do yet');
  await settle(10);
  expect(model.requests).toHaveLength(0);
  ui.app.unmount();
});

test('started where nobody has spoken, the conversation is a saved session: listed, its journal beside its state file', async () => {
  const { dir, child, ui } = await chat('FRESH-ONE', [{ hold: true }, { text: 'done here' }]);
  expect(listTree(dir)).toEqual([]);
  await ask(ui, '/subagent FRESH-ONE look around');
  await settleUntil(() => child.held);
  // The state file follows the save timer; nothing else has asked for a save.
  await settleUntil(() => listTree(dir).some((n) => n.endsWith('.json')), 200);
  const files = listTree(dir);
  const state = files.find((n) => n.endsWith('.json'))!;
  expect(state).toBeDefined();
  const id = path.basename(state, '.json');
  const journal = files.find((n) => n.endsWith('.log.jsonl'));
  expect(journal).toBeDefined();
  expect(path.dirname(journal!)).toBe(path.dirname(state));
  expect(path.basename(journal!)).toBe(`${id}.log.jsonl`);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, state), 'utf8')) as { title: string; messages: { role: string }[] };
  expect(saved.messages.some((m) => m.role === 'user')).toBe(true);
  expect(saved.title).toContain('FRESH-ONE look around');
  expect(listSessions(dir).map((x) => x.id)).toEqual([id]);
  child.release();
  await settleUntil(() => frameOf(ui).includes('◆ fresh-one-look finished:'));
  ui.app.unmount();
});

// The person's rows of the session saved in `dir`, once its state file stands.
async function savedUsers(dir: string): Promise<string[]> {
  await settleUntil(() => listTree(dir).some((n) => n.endsWith('.json')), 200);
  await new Promise((r) => setTimeout(r, 400));
  const state = listTree(dir).find((n) => n.endsWith('.json'));
  if (!state) return [];
  const saved = JSON.parse(fs.readFileSync(path.join(dir, state), 'utf8')) as { messages: { role: string; content: string }[] };
  return saved.messages.filter((m) => m.role === 'user').map((m) => m.content);
}

test('the typed line is echoed once: a second /subagent in the same conversation adds no row', async () => {
  const { dir, children: [a, b], ui } = await chatWith(['ECHO-AAA', 'ECHO-BBB']);
  await ask(ui, '/subagent ECHO-AAA one');
  await ask(ui, '/subagent ECHO-BBB two');
  await settleUntil(() => a!.held && b!.held);
  expect(await savedUsers(dir)).toEqual(['/subagent ECHO-AAA one']);
  a!.release();
  b!.release();
  ui.app.unmount();
});

test('after the person has spoken, /subagent adds no row of its own', async () => {
  const { dir, model, children: [a], ui } = await chatWith(['ECHO-CCC']);
  model.script([{ text: 'Hi there.' }]);
  await ask(ui, 'hello');
  await settleUntil(() => frameOf(ui).includes('Hi there.'));
  await ask(ui, '/subagent ECHO-CCC three');
  await settleUntil(() => a!.held);
  expect(await savedUsers(dir)).toEqual(['hello']);
  a!.release();
  ui.app.unmount();
});

test('a refused command makes no session and leaves no row', async () => {
  const { dir, model, ui } = await chat('REFUSED-ONE', [{ text: 'should not run' }]);
  await ask(ui, '/subagent --auto REFUSED-ONE fix it');
  await settleUntil(() => frameOf(ui).includes('needs writes'));
  await wipe(ui, '/subagent --auto REFUSED-ONE fix it');
  await ask(ui, '/subagent --with-context REFUSED-ONE anyway');
  await settleUntil(() => frameOf(ui).includes('no summary to hand over yet'));
  await new Promise((r) => setTimeout(r, 400));
  expect(listTree(dir)).toEqual([]);
  expect(frameOf(ui)).not.toContain('/subagent --auto REFUSED-ONE');
  expect(model.requests).toHaveLength(0);
  ui.app.unmount();
});

test('two live subagents from the same prompt get distinct labels', async () => {
  const { child, ui } = await chat('SAME-MARK', [{ hold: true }, { text: 'first' }], [{ hold: true }, { text: 'second' }]);
  await ask(ui, '/subagent SAME-MARK go');
  await settleUntil(() => child.held);
  await ask(ui, '/subagent SAME-MARK go');
  await settleUntil(() => child.requests.length === 2);
  await ask(ui, '/subagent');
  await settleUntil(() => /2 · same-mark-go-2/.test(frameOf(ui)));
  expect(frameOf(ui)).toMatch(/1 · same-mark-go · working/);
  expect(frameOf(ui)).toMatch(/2 · same-mark-go-2 · working/);
  ui.app.unmount();
});

test('it is not refused while a turn runs', async () => {
  const { model, child, ui } = await chat('BESIDE-IT', [{ hold: true }, { text: 'beside answer' }]);
  model.script([{ hold: true }, { text: 'The turn ends.' }]);
  await ask(ui, 'a long question');
  await settleUntil(() => model.held);
  await ask(ui, '/subagent BESIDE-IT meanwhile');
  await settleUntil(() => child.requests.length === 1);
  expect(child.requests).toHaveLength(1);
  // The session's turn is still the one the model holds.
  expect(model.held).toBe(true);
  expect(frameOf(ui)).toContain('subagent «beside-it-meanwhile» started');
  model.release();
  child.release();
  await settleUntil(() => frameOf(ui).includes('The turn ends.'));
  ui.app.unmount();
});
