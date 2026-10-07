// A session the chat leaves while it has work of its own stays loaded and locked, and the
// registry puts it away only once nothing of its own is left (AGENTS.md (a host makes its
// conversations through one registry)).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { workHome, type Conversation } from '../assistant/conversation.ts';
import type { Make } from '../loader/plugin.ts';
import { inBackgroundWork, workOwner } from '../runtime/background-work.ts';
import { createScreens } from '../runtime/screens.ts';
import { ScriptedModel, firstUser, type RecordedRequest } from './helpers/scripted';
import { closeRigs, conversationRig, FakePort, type Rig } from './helpers/conversation';
import { homeIn } from './helpers/session-files';

afterEach(() => { closeRigs(); });

const lockOf = (rig: Rig, id: string) => path.join(homeIn(rig.sessionsDir!, id), `${id}.lock`);
const contents = (rig: Rig, c: Conversation) => (rig.sessionFile(c.sessionId)?.messages ?? []).map((m) => String((m as { content?: unknown }).content ?? ''));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// A session on screen whose turn is held at its first request: a tool round, then a
// second held request that answers; `steps` are the requests after that.
async function heldTurnInA(steps: Parameters<ScriptedModel['script']>[0][] = []) {
  const model = new ScriptedModel();
  const sub = model.when((req) => firstUser(req).includes('question A'));
  sub.script([{ hold: true }, { tool: 'datetime', args: {} }], [{ hold: true }, { text: 'Answer A.' }], ...steps);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  rig.registry.show(rig.conv);
  void rig.conv.send('question A');
  await rig.until(() => sub.held && rig.conv.sessionId !== '');
  return { model, sub, rig };
}

test('a session left while its turn runs stays loaded and locked, and is parked when the turn ends', async () => {
  const { sub, rig } = await heldTurnInA();
  const { left: a, outcome } = rig.switchTo();
  expect(outcome).toBe('kept');
  expect(a.closed).toBe(false);
  expect(rig.conv).not.toBe(a);
  expect(rig.registry.statusOf(a.sessionId)).toBe('working');
  sub.release();
  await rig.until(() => sub.held); // the second request, held
  // The tool round is behind it: its end of round asked for a check, and none parked.
  await rig.until(() => rig.journal(a.sessionId).some((e) => e.t === 'call'));
  await tick(300);
  expect(a.closed).toBe(false);
  expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(true);
  sub.release();
  await rig.until(() => a.closed);
  expect(a.closeReason).toBe('park');
  expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(false);
  expect(contents(rig, a)).toContain('Answer A.');
});

test('a queued message goes out after a left turn ends; the park comes only after its own turn', async () => {
  const { model, sub, rig } = await heldTurnInA([[{ text: 'Answer to the queued one.' }]]);
  rig.conv.enqueue('and one more thing');
  // Held with ⇥, so it waits for the turn's end rather than going out mid-turn.
  rig.conv.toggleHoldLast();
  const { left: a } = rig.switchTo();
  sub.release();
  await rig.until(() => sub.held);
  sub.release();
  await rig.until(() => a.closed, 10_000);
  expect(a.closeReason).toBe('park');
  expect(model.requests.length).toBe(3);
  expect(sub.requests.map((r) => r.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).at(-1))).toContain('and one more thing');
  expect(contents(rig, a)).toContain('Answer to the queued one.');
});

test('park refuses a conversation that still works', async () => {
  const { sub, rig } = await heldTurnInA();
  const a = rig.conv;
  expect(() => rig.registry.park(a)).toThrow('registry.park: the conversation still has work of its own');
  expect(a.closed).toBe(false);
  expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(true);
  sub.release();
});

test('a settings y/n raised at a left turn\'s end holds the park; answered, the park comes after its ask settles', async () => {
  const model = new ScriptedModel();
  const sub = model.when((req) => firstUser(req).includes('question A'));
  sub.script([{ hold: true }, { text: 'Answer A.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  let armed = false;
  let applied = false;
  const change = { file: 'config.local.json', path: path.join(rig.root, 'config.local.json'), keys: ['shell.autoRun'], lines: ['shell.autoRun: (unset) → true'], hash: 'h1', mtimeMs: 1, size: 1, content: {}, raw: '{}' };
  (rig.services as unknown as { configChanges: unknown }).configChanges = {
    check: () => (armed && !applied ? [change] : []),
    apply: () => { applied = true; return { applied: ['shell.autoRun'], restart: [] }; },
    decline: () => null,
  };
  rig.registry.show(rig.conv);
  void rig.conv.send('question A');
  await rig.until(() => sub.held && rig.conv.sessionId !== '');
  const { left: a } = rig.switchTo();
  armed = true;
  sub.release();
  await rig.until(() => a.confirm?.name === 'config');
  expect(rig.pendingIn(a)?.name).toBe('config');
  await tick(100);
  // The turn is over and its check has run: the y/n alone keeps the session here.
  expect(a.busy).toBe(false);
  expect(a.closed).toBe(false);
  expect(rig.registry.statusOf(a.sessionId)).toBe('waiting');
  // Answered where it waits, as a router of answers would.
  a.answerConfirm(true);
  // The answer's own event comes while the ask is still in flight: nothing parks inside it.
  expect(a.closed).toBe(false);
  await rig.until(() => a.closed, 3000);
  expect(a.closeReason).toBe('park');
  expect(applied).toBe(true);
  expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(false);
});

test('a session left with nothing of its own is parked at once', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Answer A.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  rig.registry.show(rig.conv);
  await rig.conv.send('question A');
  await rig.idle();
  const id = rig.conv.sessionId;
  expect(fs.existsSync(lockOf(rig, id))).toBe(true);
  const { left: a, outcome } = rig.switchTo();
  expect(outcome).toBe('parked');
  expect(a.closed).toBe(true);
  expect(a.closeReason).toBe('park');
  expect(a.headless).toBe(false);
  expect(fs.existsSync(lockOf(rig, id))).toBe(false);
  expect(rig.conv).not.toBe(a);
  expect(rig.registry.shown()).toBe(rig.conv);
});

test('a left session taken back mid-turn is not parked when its turn ends', async () => {
  const { sub, rig } = await heldTurnInA();
  const { left: a, outcome } = rig.switchTo();
  expect(outcome).toBe('kept');
  rig.switchTo(a);
  expect(rig.conv).toBe(a);
  sub.release();
  await rig.until(() => sub.held);
  sub.release();
  await rig.idle();
  await tick(300);
  expect(a.closed).toBe(false);
  expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(true);
  expect(contents(rig, a)).toContain('Answer A.');
});

test('a session retired twice is watched once: one trigger is one check', async () => {
  const { sub, rig } = await heldTurnInA();
  const { left: a } = rig.switchTo();
  expect(rig.registry.retire(a)).toBe('kept');
  let reads = 0;
  const quiescent = rig.registry.quiescent.bind(rig.registry);
  rig.registry.quiescent = (c) => { if (c === a) reads++; return quiescent(c); };
  a.emit({ type: 'children', count: 0 });
  await tick(50);
  expect(reads).toBe(1);
  expect(a.closed).toBe(false);
  sub.release();
});

test('a park that throws in the deferred check is logged and retried by the next trigger', async () => {
  const { sub, rig } = await heldTurnInA();
  const { left: a } = rig.switchTo();
  const release = a.releaseLock.bind(a);
  let failed = false;
  a.releaseLock = () => { if (!failed) { failed = true; throw new Error('disk gone'); } release(); };
  sub.release();
  await rig.until(() => sub.held);
  sub.release();
  await rig.until(() => failed);
  await tick(50);
  expect(a.closed).toBe(false);
  expect(rig.log.some((l) => l.includes('disk gone'))).toBe(true);
  // The watch is still there: a later trigger parks it.
  a.emit({ type: 'children', count: 0 });
  await rig.until(() => a.closed);
  expect(a.closeReason).toBe('park');
  expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(false);
});

class DraftPort extends FakePort {
  constructor(private text: string) { super(true); }
  draft(): string { return this.text; }
}

test('a left turn that fails with a queued message puts the queue into the saved draft and is parked', async () => {
  const realFetch = globalThis.fetch;
  try {
    const { sub, rig } = await heldTurnInA();
    rig.conv.enqueue('queued while it ran');
    rig.conv.toggleHoldLast();
    const { left: a } = rig.switchTo();
    // The next request fails: the provider is gone.
    globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    sub.release();
    await rig.until(() => a.closed, 10_000);
    expect(a.lastEnd).toMatchObject({ kind: 'turn', outcome: 'failed' });
    expect(fs.existsSync(lockOf(rig, a.sessionId))).toBe(false);
    expect(rig.sessionFile(a.sessionId)?.draft).toBe('queued while it ran');
  } finally { globalThis.fetch = realFetch; }
});

test('a left turn that fails puts the queue ahead of the draft kept at the leave', async () => {
  const realFetch = globalThis.fetch;
  try {
    const { sub, rig } = await heldTurnInA();
    const a = rig.conv;
    a.enqueue('queued while it ran');
    a.toggleHoldLast();
    // The field held text when the person left: the port gives it up on detach.
    a.detach(rig.port);
    const typed = new DraftPort('typed at the leave');
    a.attach(typed);
    a.detach(typed);
    rig.switchTo();
    globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    sub.release();
    await rig.until(() => a.closed, 10_000);
    expect(rig.sessionFile(a.sessionId)?.draft).toBe('queued while it ran\n\ntyped at the leave');
  } finally { globalThis.fetch = realFetch; }
});

// A session whose turn reaches a y/n for `echo hi`, with `alert` counted on the services.
function yesNoRig(alerts: string[]) {
  const model = new ScriptedModel();
  const sub = model.when((req) => firstUser(req).includes('question A'));
  sub.script([{ hold: true }, { tool: 'run_command', args: { command: 'echo hi' } }], [{ text: 'Ran it.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  (rig.services as unknown as { alert: (t: string, b?: string) => void }).alert = (_t, b) => { alerts.push(String(b)); };
  return { model, sub, rig };
}
const waits = (rig: Rig, tail = 'waits for your answer') => rig.toasts.filter((t) => t.includes(tail));

test('a left session\'s y/n reads waiting, is said once with a toast and an alert, answers nothing, and holds the park until answered after attach', async () => {
  const alerts: string[] = [];
  const { sub, rig } = yesNoRig(alerts);
  rig.registry.show(rig.conv);
  void rig.conv.send('question A');
  await rig.until(() => sub.held && rig.conv.sessionId !== '');
  const { left: a } = rig.switchTo();
  sub.release();
  await rig.until(() => !!rig.pendingIn(a));
  expect(rig.pendingIn(a)?.name).toBe('run_command');
  expect(rig.registry.statusOf(a.sessionId)).toBe('waiting');
  expect(waits(rig)).toHaveLength(1);
  expect(waits(rig)[0]).toContain('a y/n');
  expect(alerts).toHaveLength(1);
  await tick(500);
  expect(a.closed).toBe(false);
  expect(sub.requests).toHaveLength(1); // nothing answered it: the command did not run
  rig.switchTo(a);
  a.answerConfirm(true);
  await rig.until(() => contents(rig, a).includes('Ran it.'));
  expect(a.closed).toBe(false); // attached again: never parked
  expect(waits(rig)).toHaveLength(1);
  expect(alerts).toHaveLength(1);
});

test('a left session\'s ask_user reads waiting with its toast, and holds the park until answered', async () => {
  const model = new ScriptedModel();
  const sub = model.when((req) => firstUser(req).includes('question A'));
  sub.script([{ hold: true }, { tool: 'ask_user', args: { questions: [{ question: 'Which one?', options: [{ label: 'left' }, { label: 'right' }] }] } }], [{ text: 'Went left.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  rig.registry.show(rig.conv);
  void rig.conv.send('question A');
  await rig.until(() => sub.held && rig.conv.sessionId !== '');
  const { left: a } = rig.switchTo();
  sub.release();
  await rig.until(() => !!a.question);
  expect(rig.registry.statusOf(a.sessionId)).toBe('waiting');
  expect(waits(rig, 'waits for your answer — a question')).toHaveLength(1);
  await tick(300);
  expect(a.closed).toBe(false);
  a.dismissQuestion();
  await rig.until(() => a.closed, 3000);
});

test('a settings y/n in a left session is named as one', async () => {
  const model = new ScriptedModel();
  const sub = model.when((req) => firstUser(req).includes('question A'));
  sub.script([{ hold: true }, { text: 'Answer A.' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  let armed = false;
  let applied = false;
  const change = { file: 'config.local.json', path: path.join(rig.root, 'config.local.json'), keys: ['shell.autoRun'], lines: ['shell.autoRun: (unset) → true'], hash: 'h1', mtimeMs: 1, size: 1, content: {}, raw: '{}' };
  (rig.services as unknown as { configChanges: unknown }).configChanges = {
    check: () => (armed && !applied ? [change] : []),
    apply: () => { applied = true; return { applied: ['shell.autoRun'], restart: [] }; },
    decline: () => null,
  };
  rig.registry.show(rig.conv);
  void rig.conv.send('question A');
  await rig.until(() => sub.held && rig.conv.sessionId !== '');
  const { left: a } = rig.switchTo();
  armed = true;
  sub.release();
  await rig.until(() => a.confirm?.name === 'config');
  expect(waits(rig)).toHaveLength(1);
  expect(waits(rig)[0].endsWith('a settings y/n')).toBe(true);
  a.answerConfirm(true);
  await rig.until(() => a.closed, 3000);
});

test('a session left while its y/n waits is announced once', async () => {
  const alerts: string[] = [];
  const { sub, rig } = yesNoRig(alerts);
  rig.registry.show(rig.conv);
  void rig.conv.send('question A');
  await rig.until(() => sub.held && rig.conv.sessionId !== '');
  sub.release();
  await rig.until(() => !!rig.pendingIn(rig.conv));
  // On screen: asked, not left, so nothing is said yet.
  expect(waits(rig)).toHaveLength(0);
  expect(alerts).toHaveLength(0);
  const { left: a, outcome } = rig.switchTo();
  expect(outcome).toBe('kept');
  expect(waits(rig)).toHaveLength(1);
  expect(alerts).toHaveLength(1);
  // Retired again while it still waits: the same wait is not said twice.
  expect(rig.registry.retire(a)).toBe('kept');
  await tick(100);
  expect(waits(rig)).toHaveLength(1);
  expect(alerts).toHaveLength(1);
  a.answerConfirm(false);
  await rig.until(() => a.closed, 5000);
});

test('a conversation never shown and never left announces nothing', async () => {
  const alerts: string[] = [];
  const { sub, rig } = yesNoRig(alerts);
  // No registry.show: the rig's conversation is on no screen and was never left.
  void rig.conv.send('question A');
  await rig.until(() => sub.held && rig.conv.sessionId !== '');
  sub.release();
  await rig.until(() => !!rig.pendingIn(rig.conv));
  await tick(100);
  expect(rig.registry.shown()).toBeNull();
  expect(waits(rig)).toHaveLength(0);
  expect(alerts).toHaveLength(0);
  rig.answerNext(false);
});

// A stub of the App's screens service that records each turn's end it is told of.
function flushesOf(rig: Rig): boolean[] {
  const flushed: boolean[] = [];
  (rig.services as unknown as { screens: unknown }).screens = { promptBlock: () => '', afterTurn: (ok: boolean) => { flushed.push(ok); } };
  return flushed;
}

test('only a session that was not left flushes deferred screens at its turn\'s end', async () => {
  const { model, sub, rig } = await heldTurnInA();
  const flushed = flushesOf(rig);
  const { left: a } = rig.switchTo();
  const b = rig.conv;
  sub.release();
  await rig.until(() => sub.held);
  sub.release();
  await rig.until(() => a.closed);
  expect(a.closeReason).toBe('park');
  expect(flushed).toEqual([]);
  model.script([{ text: 'B answer.' }]);
  await b.send('question B');
  expect(flushed).toEqual([true]);
});

test('/clear during a turn still drops that turn\'s deferred screens', async () => {
  const { sub, rig } = await heldTurnInA();
  const flushed = flushesOf(rig);
  // As the chat's `/clear` closes it: the port goes with the close, before the stopped
  // turn reaches its end.
  rig.conv.close('clear');
  expect(rig.conv.attached).toBe(false);
  await rig.until(() => flushed.length > 0, 3000);
  expect(flushed).toEqual([false]);
  sub.release();
});

const WORKER = 'You are a background worker';
const systemOf = (req: RecordedRequest): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
const isTask = (req: RecordedRequest, task: string) => systemOf(req).includes(WORKER) && systemOf(req).includes(`Task: ${task}`);
const isSession = (req: RecordedRequest, question: string) => !systemOf(req).includes(WORKER) && firstUser(req).includes(question);
// A guest tool with no arguments that runs `read` where it is called from.
const probeTool = (name: string, read: () => void) => (make: Make) => make(`${name}-plugin`, {
  tools: [{
    id: name,
    tools: [{ type: 'function', function: { name, description: 'Reads where it is called from.', parameters: { type: 'object', properties: {} } } }],
    exec: async () => { read(); return 'read'; },
  }],
});

test('a task queued behind another session\'s task works for its own session', async () => {
  const homes: (Conversation | null)[] = [];
  const model = new ScriptedModel();
  model.when((req) => isSession(req, 'question B')).script([{ tool: 'background', args: { task: 'job B', label: 'tb' } }], [{ text: 'Started B.' }]);
  model.when((req) => isSession(req, 'question A')).script([{ tool: 'background', args: { task: 'job A', label: 'ta' } }], [{ text: 'Started A.' }]);
  const tb = model.when((req) => isTask(req, 'job B'));
  tb.script([{ hold: true }, { tool: 'whose', args: {} }], [{ text: 'b done' }]);
  const ta = model.when((req) => isTask(req, 'job A'));
  ta.script([{ tool: 'whose', args: {} }], [{ text: 'a done' }]);
  // One task at a time.
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false }, extra: { sessions: { maxRunning: 2 } }, guests: (make) => [probeTool('whose', () => { homes.push(workHome()); })(make)] });
  const b = rig.conv;
  await b.send('question B');
  await rig.until(() => tb.held);
  const a = rig.fresh();
  await a.send('question A');
  // B's task holds the one slot; A's has left its delay and waits behind it.
  await rig.until(() => rig.registry.children.backgroundCount() === 2 && a.childTimers.size === 0);
  await tick();
  expect(rig.registry.children.running()).toBe(1);
  expect(ta.requests).toHaveLength(0);
  expect(b.closed).toBe(false);
  tb.release();
  await rig.until(() => rig.registry.children.backgroundCount() === 0 && homes.length === 2, 5000);
  expect(homes[0]).toBe(b);
  expect(homes[1]).toBe(a);
});

test('a follow-up turn after a grandchild\'s result is not background work', async () => {
  const marks: boolean[] = [];
  const model = new ScriptedModel();
  model.when((req) => isTask(req, 'one')).script([{ tool: 'background', args: { task: 'two', label: 'b' } }], [{ text: 'a done' }]);
  const two = model.when((req) => isTask(req, 'two'));
  two.script([{ hold: true }, { text: 'b done' }]);
  // The session: its own turn, then one follow-up turn per result, each calling the tool.
  model.script(
    [{ tool: 'background', args: { task: 'one', label: 'a' } }], [{ text: 'Started.' }],
    [{ tool: 'mark', args: {} }], [{ text: 'Read a.' }],
    [{ tool: 'mark', args: {} }], [{ text: 'Read b.' }],
  );
  const rig = conversationRig(model, { guests: (make) => [probeTool('mark', () => { marks.push(inBackgroundWork()); })(make)] });
  const first = rig.conv;
  rig.registry.show(first);
  await first.send('go');
  // Task `a` started `b` and ended; its result's follow-up turn is over, `b` still held.
  await rig.until(() => two.held && marks.length === 1 && first.rows().some((m) => m.content === 'Read a.') && !first.busy, 5000);
  two.release();
  await rig.until(() => marks.length === 2 && first.rows().some((m) => m.content === 'Read b.') && !first.busy, 5000);
  // The second one is started from inside task `a`'s run, which is background work.
  expect(marks).toEqual([false, false]);
});

test('a task\'s own turn is still background work', async () => {
  const marks: boolean[] = [];
  const opens: string[] = [];
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'one', label: 'a' } }], [{ text: 'Started.' }]);
  model.when((req) => isTask(req, 'one')).script([{ tool: 'mark', args: {} }, { tool: 'open_it', args: {} }], [{ text: 'a done' }]);
  let opened = 0;
  const screens = createScreens({
    plugins: [{ name: 'shown', screens: { main: { entry: true, open: () => { opened++; } } } }] as never,
    builtins: ['core'], disabled: new Set(), untrusted: () => [], starting: () => [], keys: {}, apiOf: () => ({}),
    busy: () => false, blocker: () => null, asking: () => false, covered: () => false, notify: () => {}, log: () => {}, say: () => {},
  });
  const rig = conversationRig(model, {
    ai: { backgroundFollowUp: false },
    guests: (make) => [
      probeTool('mark', () => { marks.push(inBackgroundWork()); })(make),
      // A plugin's navigation tool, and the model's `ui_open`, both through the screens' rules.
      make('opener', {
        tools: [{
          id: 'opener',
          tools: [{ type: 'function', function: { name: 'open_it', description: 'Opens a screen.', parameters: { type: 'object', properties: {} } } }],
          exec: async () => { opens.push((await screens.open('shown', 'main')).text, (await screens.uiOpen('shown')).text); return 'asked'; },
        }],
      }),
    ],
  });
  await rig.conv.send('go');
  await rig.until(() => rig.registry.children.backgroundCount() === 0 && opens.length === 2, 5000);
  expect(marks).toEqual([true]);
  expect(opens).toEqual(['Not opened: screens are not opened from background work.', 'Not opened: screens are not opened from background work.']);
  expect(opened).toBe(0);
});

for (const outcome of ['kept', 'parked'] as const) {
  test(`a screen a session deferred is dropped when the chat leaves it (${outcome})`, async () => {
    const model = new ScriptedModel();
    const sub = model.when((req) => firstUser(req).includes('question A'));
    // Kept: left while its second request is held. Parked: left once the turn is over.
    sub.script([{ tool: 'open_it', args: {} }], [...(outcome === 'kept' ? [{ hold: true } as const] : []), { text: 'Answer A.' }]);
    const log: string[] = [];
    // A question waits for the person, so the open is deferred and the turn's end keeps it.
    const screens = createScreens({
      plugins: [{ name: 'shown', screens: { main: { entry: true, open: () => {} } } }] as never,
      builtins: ['core'], disabled: new Set(), untrusted: () => [], starting: () => [], keys: {}, apiOf: () => ({}),
      busy: () => true, blocker: () => 'a question waits', asking: () => true, covered: () => false, notify: () => {}, log: (line) => { log.push(line); }, say: () => {},
    });
    const rig = conversationRig(model, {
      ai: { backgroundFollowUp: false },
      guests: (make) => [make('opener', {
        tools: [{
          id: 'opener',
          tools: [{ type: 'function', function: { name: 'open_it', description: 'Opens a screen.', parameters: { type: 'object', properties: {} } } }],
          exec: async () => (await screens.uiOpen('shown')).text,
        }],
      })],
    });
    (rig.services as unknown as { screens: unknown }).screens = screens;
    rig.registry.show(rig.conv);
    const sent = rig.conv.send('question A');
    if (outcome === 'kept') await rig.until(() => sub.held);
    else { await sent; await rig.idle(); }
    expect(screens.pending()).toEqual(['shown:main']);
    expect(rig.switchTo().outcome).toBe(outcome);
    expect(screens.pending()).toEqual([]);
    expect(log).toContain('[screens] shown:main not opened — its session was left');
    sub.release();
  });
}

// The settings guard as a stub: `pending` is what `check` answers, `apply` and `decline`
// take a change out of it and are logged.
function settingsGuard(rig: Rig) {
  const change = (file: string, hash = 'h1') => ({ file, path: path.join(rig.root, file), keys: ['k'], lines: ['k: (unset) → 1'], hash, mtimeMs: 1, size: 1, content: {}, raw: '{}' });
  const guard = { pending: [] as ReturnType<typeof change>[], answered: [] as string[], change };
  const take = (how: string) => (ch: { file: string; path: string }) => { guard.pending = guard.pending.filter((x) => x.path !== ch.path); guard.answered.push(`${how} ${ch.file}`); };
  (rig.services as unknown as { configChanges: unknown }).configChanges = {
    check: () => [...guard.pending],
    apply: (ch: { file: string; path: string }) => { take('apply')(ch); return { applied: ['k'], restart: [] }; },
    decline: (ch: { file: string; path: string }) => { take('decline')(ch); return null; },
  };
  return guard;
}
// Two sessions of one host, both open; nothing runs in either.
function twoSessions() {
  const rig = conversationRig(new ScriptedModel(), { ai: { backgroundFollowUp: false } });
  const a = rig.conv;
  const b = rig.fresh();
  return { rig, a, b, guard: settingsGuard(rig) };
}
const asks = (c: Conversation) => c.confirmDrawn?.title ?? '';
const notes = (c: Conversation) => c.rows().map((m) => String(m.content));

test('a settings change answered in another session meanwhile is not asked again, and nothing is said of it', async () => {
  const { a, b, guard } = twoSessions();
  guard.pending = [guard.change('f1.json'), guard.change('f2.json')];
  void a.askConfigChanges();
  expect(asks(a)).toContain('f1.json changed outside flow-assist');
  // The other session asks what is nobody's yet, and the person answers it there.
  void b.askConfigChanges();
  expect(asks(b)).toContain('f2.json changed outside flow-assist');
  b.answerConfirm(true);
  await tick();
  a.answerConfirm(true);
  await tick();
  expect(guard.answered).toEqual(['apply f2.json', 'apply f1.json']);
  expect(a.confirm).toBeNull();
  expect(a.configAsk).toBeNull();
  expect(notes(a)).toEqual(['Applied f1.json: k.']);
});

test('a settings change another session still asks is left to it when its turn in the batch comes', async () => {
  const { a, b, guard } = twoSessions();
  guard.pending = [guard.change('f1.json'), guard.change('f2.json')];
  void a.askConfigChanges();
  void b.askConfigChanges();
  expect(asks(b)).toContain('f2.json changed outside flow-assist');
  a.answerConfirm(true);
  await tick();
  // f2 is still the other session's: not asked here too, and still its own to answer.
  expect(a.confirm).toBeNull();
  expect(asks(b)).toContain('f2.json changed outside flow-assist');
  b.answerConfirm(false);
  await tick();
  expect(guard.answered).toEqual(['apply f1.json', 'decline f2.json']);
  expect(notes(a)).toEqual(['Applied f1.json: k.']);
});

test('a settings file answered in one session and changed again is asked by another', async () => {
  const { a, b, guard } = twoSessions();
  guard.pending = [guard.change('f1.json')];
  void a.askConfigChanges();
  a.answerConfirm(true);
  await tick();
  expect(guard.answered).toEqual(['apply f1.json']);
  guard.pending = [guard.change('f1.json', 'h2')];
  void b.askConfigChanges();
  expect(asks(b)).toContain('f1.json changed outside flow-assist');
  b.answerConfirm(false);
  await tick();
});

test('a settings change whose asker was closed is asked by the next session at once', async () => {
  const { rig, a, b, guard } = twoSessions();
  guard.pending = [guard.change('f1.json')];
  void a.askConfigChanges();
  expect(asks(a)).toContain('f1.json changed outside flow-assist');
  // As `/clear` closes it: the y/n is declined by the reset, and its entry is still the
  // closed conversation's when the next one asks in the same step.
  a.close('clear');
  void b.askConfigChanges();
  expect(asks(b)).toContain('f1.json changed outside flow-assist');
  await tick();
  // The closed asker's unwinding leaves the entry of the one asking it since: a third
  // session finds the change taken.
  const third = rig.fresh();
  void third.askConfigChanges();
  expect(third.confirm).toBeNull();
  expect(asks(b)).toContain('f1.json changed outside flow-assist');
  b.answerConfirm(true);
  await tick();
  expect(guard.answered).toEqual(['apply f1.json']);
  expect(notes(b)).toEqual(['Applied f1.json: k.']);
});

test('a settings file answered is free at once, though its asker still asks about another', async () => {
  const { a, b, guard } = twoSessions();
  guard.pending = [guard.change('f1.json'), guard.change('f2.json')];
  void a.askConfigChanges();
  a.answerConfirm(true);
  await tick();
  expect(asks(a)).toContain('f2.json changed outside flow-assist');
  // f1 changes again while its first asker waits on f2.
  guard.pending = [...guard.pending, guard.change('f1.json', 'h2')];
  void b.askConfigChanges();
  expect(asks(b)).toContain('f1.json changed outside flow-assist');
  b.answerConfirm(true);
  a.answerConfirm(true);
  await tick();
  expect(guard.answered).toEqual(['apply f1.json', 'apply f1.json', 'apply f2.json']);
});

test('a conversation\'s listeners and handlers run as nobody\'s work; a tool of the same turn as the turn\'s', async () => {
  const told: unknown[] = [];
  const heard: unknown[] = [];
  const called: unknown[] = [];
  const model = new ScriptedModel();
  model.script([{ text: 'Next: a look.' }, { tool: 'look', args: {} }], [{ text: 'Looked.' }]);
  const rig = conversationRig(model, { guests: (make) => [probeTool('look', () => { called.push(workOwner()); })(make)] });
  const c = rig.conv;
  c.subscribe(() => { told.push(workOwner()); });
  for (const type of ['turn-start', 'activity', 'turn-end'] as const) c.on(type, () => { heard.push(workOwner()); });
  await c.send('look');
  await rig.idle();
  expect(called).toEqual([c]);
  expect(told.length).toBeGreaterThan(2);
  expect(told.filter((o) => o !== undefined)).toEqual([]);
  expect(heard.length).toBeGreaterThan(1);
  expect(heard.filter((o) => o !== undefined)).toEqual([]);
});

test('a handler that hears a grandchild\'s end is nobody\'s work, and the background mark of the run it comes from stays', async () => {
  const heard: { owner: unknown; background: boolean }[] = [];
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'one', label: 'a' } }], [{ text: 'Started.' }]);
  model.when((req) => isTask(req, 'one')).script([{ tool: 'background', args: { task: 'two', label: 'b' } }], [{ text: 'a done' }]);
  const two = model.when((req) => isTask(req, 'two'));
  two.script([{ hold: true }, { text: 'b done' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  const first = rig.conv;
  await first.send('go');
  await rig.until(() => two.held && first.children.size === 1 && !first.busy, 5000);
  first.on('children', () => { heard.push({ owner: workOwner(), background: inBackgroundWork() }); });
  two.release();
  await rig.until(() => rig.registry.children.backgroundCount() === 0 && heard.length === 1, 5000);
  // `b` was started from task `a`'s turn: its run, and the event it ends with, carry that mark.
  expect(heard).toEqual([{ owner: undefined, background: true }]);
});

test('a session taken back and left again while its y/n still waits is announced again', async () => {
  const alerts: string[] = [];
  const { sub, rig } = yesNoRig(alerts);
  rig.registry.show(rig.conv);
  void rig.conv.send('question A');
  await rig.until(() => sub.held && rig.conv.sessionId !== '');
  sub.release();
  await rig.until(() => !!rig.pendingIn(rig.conv));
  const { left: a } = rig.switchTo();
  expect(waits(rig)).toHaveLength(1);
  expect(alerts).toHaveLength(1);
  // Taken back, looked at, and left unanswered.
  rig.switchTo(a);
  expect(rig.conv).toBe(a);
  expect(waits(rig)).toHaveLength(1);
  expect(rig.switchTo().outcome).toBe('kept');
  expect(waits(rig)).toHaveLength(2);
  expect(alerts).toHaveLength(2);
  a.answerConfirm(false);
  await rig.until(() => a.closed, 5000);
});
