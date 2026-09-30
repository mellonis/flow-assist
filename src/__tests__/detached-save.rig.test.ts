// A conversation no port draws saves what it holds: its own list and the draft it kept
// when its port left (AGENTS.md (a session is one object)).
import { afterEach, expect, test } from 'bun:test';
import { writeSession } from '../assistant/conversation-session.ts';
import { ScriptedModel } from './helpers/scripted';
import { closeRigs, conversationRig, FakePort } from './helpers/conversation';

afterEach(() => closeRigs());

class DraftPort extends FakePort {
  constructor(private text: string) { super(true); }
  draft(): string { return this.text; }
}

async function saidOnce() {
  const model = new ScriptedModel();
  model.script([{ text: 'Hello.' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  await rig.conv.send('hi');
  await rig.until(() => rig.conv.status === 'idle' || !rig.conv.busyDrawn);
  return rig;
}

test('a detached conversation saves the draft its port held', async () => {
  const rig = await saidOnce();
  const c = rig.conv;
  const port = new DraftPort('half a thought');
  c.attach(port);
  c.detach(port);
  writeSession(c);
  expect(rig.sessionFile(c.sessionId)?.draft).toBe('half a thought');
});

test('a row that lands after the port left is saved, though the drawn list lacks it', async () => {
  const rig = await saidOnce();
  const c = rig.conv;
  const port = new FakePort(true);
  c.attach(port);
  c.drawnRows = [...c.messages]; // the list as the chat last drew it
  c.detach(port);
  c.deliver('late result');
  expect(c.messages.some((m) => String(m.content).includes('late result'))).toBe(true);
  expect(c.drawnRows.some((m) => String(m.content).includes('late result'))).toBe(false);
  writeSession(c);
  const saved = rig.sessionFile(c.sessionId)!;
  expect(saved.messages.some((m) => String((m as { content?: unknown }).content).includes('late result'))).toBe(true);
});
