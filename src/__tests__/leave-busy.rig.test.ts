// A session the chat leaves while it has work of its own stays loaded and locked, and the
// registry puts it away only once nothing of its own is left (AGENTS.md (a host makes its
// conversations through one registry)).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { Conversation } from '../assistant/conversation.ts';
import { ScriptedModel, firstUser } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';
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
