// The rig itself: a turn through the host's real services, a journal and a state file of
// the test's own; two conversations in flight at once, each with its own script
// (`ScriptedModel.when`); a session opened again; and no conversation that asks where
// nobody can answer.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, firstUser } from './helpers/scripted';
import { conversationRig } from './helpers/conversation';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('a turn goes through the host\'s services: the answer, the history, the journal, the saved file', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'Noon.' }]);
  const rig = conversationRig(model);
  expect(await rig.conv.send('what time is it')).toBe(true);
  expect(rig.conv.lastAnswer()).toBe('Noon.');
  expect(rig.conv.api.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  expect(rig.journal().map((e) => e.t)).toEqual(['start', 'row', 'call-start', 'call', 'answer', 'end']);
  rig.conv.save();
  expect(rig.sessionFile()!.api).toHaveLength(4);
  expect(rig.sent(0).map((m) => m.role)).toEqual(['user']);
});

test('ScriptedModel.when: two conversations in flight at once, each answered from its own script', async () => {
  const model = new ScriptedModel();
  const a = model.when((r) => firstUser(r) === 'job A');
  a.script([{ text: 'A, part one. ' }, { hold: true }, { text: 'A done.' }]);
  model.script([{ text: 'B done.' }]);
  const rig = conversationRig(model);
  const first = rig.conv;
  const runA = first.send('job A');
  await rig.until(() => a.held);
  const second = rig.fresh();
  await second.send('job B');                       // B ends while A still holds
  expect(second.lastAnswer()).toBe('B done.');
  expect(first.busy).toBe(true);
  a.release();
  await runA;
  expect(first.lastAnswer()).toBe('A, part one. A done.');
  expect(a.requests).toHaveLength(1);
  expect(model.requests).toHaveLength(2);           // every request is recorded on the main script too
  expect(rig.journal(first.sessionId).some((e) => e.t === 'answer' && e.text === 'A, part one. A done.')).toBe(true);
  expect(rig.journal(second.sessionId).some((e) => e.t === 'answer' && e.text === 'A, part one. A done.')).toBe(false);
});

test('a saved session opens again into a conversation of its own, and goes on in its own journal', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'first answer' }], [{ text: 'second answer' }]);
  const rig = conversationRig(model);
  await rig.conv.send('first question');
  rig.conv.save();
  const id = rig.conv.sessionId;
  rig.conv.releaseLock();
  rig.conv.close('park');
  const opened = rig.open(id);
  expect(opened.lastAnswer()).toBe('first answer');
  await opened.send('second question');
  expect(rig.sent().map((m) => m.content)).toEqual(['first question', 'first answer', 'second question']);
  expect(rig.journal(id).filter((e) => e.t === 'row' && e.role === 'user').map((e) => e.text)).toEqual(['first question', 'second question']);
});

test('where nobody can answer, a conversation that asks cannot be made', () => {
  expect(() => conversationRig(new ScriptedModel(), { canAsk: false })).toThrow(/nobody to ask/);
  const rig = conversationRig(new ScriptedModel(), { canAsk: false, kind: 'oneshot', policy: { kind: 'none' } });
  expect(rig.conv.kind).toBe('oneshot');
});
