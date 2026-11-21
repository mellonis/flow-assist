// A message queued during a running turn reaches the model at the next request boundary —
// after the current tool results — as the person's message; taken back, it never goes;
// held (⇥), it waits for the turn's end, and so does one that names an image, with every
// message behind it. The queue line and the field are queue-mid-turn.e2e.test.ts.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageToken, loadImageFile } from '../assistant/images';
import { ScriptedModel } from './helpers/scripted';
import { closeRigs, conversationRig } from './helpers/conversation';
import { png } from './helpers/image-fixtures';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; closeRigs(); });
type Msg = { role: string; content: unknown };

// The first round calls a tool and then holds: the person queues a message meanwhile.
async function heldTurn(...more: Parameters<ScriptedModel['script']>) {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }, { hold: true }], [{ text: 'Adjusted.' }], ...more);
  const rig = conversationRig(model);
  const turn = rig.conv.send('do the long thing');
  await rig.until(() => model.held);
  rig.conv.enqueue('not there, the other file');
  return { model, rig, turn, messages: (i: number) => rig.messages(i) as Msg[] };
}

test('a queued message reaches the model after the current step, as the person\'s message, and the turn goes on with it', async () => {
  const { model, rig, turn, messages } = await heldTurn();
  expect(rig.conv.queueWait(rig.conv.queue, 0)).toBe('step');
  expect(model.requests).toHaveLength(1);
  model.release();
  await turn;
  // Delivered at the boundary: after the call and its result, in the same turn.
  const sent = messages(1);
  const wire = sent.at(-1)!;
  expect(wire.role).toBe('user');
  // The model reads it framed as steered in mid-turn.
  expect(String(wire.content).startsWith('not there, the other file\n\n')).toBe(true);
  expect(String(wire.content)).toContain('steered in mid-turn');
  // One variant, never the other: the drain's wording is not on a delivered message.
  expect(String(wire.content)).not.toContain('previous turn');
  expect(sent.at(-2)!.role).toBe('tool');
  // No second turn was started for it.
  await rig.idle();
  expect(model.requests).toHaveLength(2);
  // And it stays in the model's history for the next turn, framed as it was sent.
  model.script([{ text: 'ok' }]);
  await rig.conv.send('next');
  expect(JSON.stringify(messages(2))).toContain('not there, the other file');
  expect(JSON.stringify(messages(2))).toContain('steered in mid-turn');
});

test('a delivered queued message goes to the model framed as steered in, and the row keeps it as typed', async () => {
  const { model, rig, turn, messages } = await heldTurn();
  model.release();
  await turn;
  const sent = messages(1);
  const wire = sent.at(-1) as Msg;
  expect(wire.role).toBe('user');
  expect(String(wire.content)).toContain('not there, the other file');
  expect(String(wire.content)).toContain('steered in mid-turn');
  expect(String(wire.content)).not.toContain('previous turn');
  // The screen row and the journal keep the text as typed; the row is marked as
  // delivered mid-turn, which is what the answer to it is drawn from.
  const row = rig.conv.messages.find((m) => m.role === 'user' && m.content === 'not there, the other file');
  expect(row).toEqual({ role: 'user', content: 'not there, the other file', midTurn: true });
  const rows = rig.journal().filter((e) => e.t === 'row' && e.role === 'user' && e.text === 'not there, the other file');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ midTurn: true });
  expect(JSON.stringify(rig.conv.messages)).not.toContain('steered in mid-turn');
  expect(JSON.stringify(rig.journal())).not.toContain('steered in mid-turn');
  expect(JSON.stringify(rig.conv.messages)).not.toContain('previous turn');
  expect(JSON.stringify(rig.journal())).not.toContain('previous turn');
});

test('↑ takes a queued message back before it is delivered', async () => {
  const { model, rig, turn, messages } = await heldTurn();
  expect(rig.conv.takeBackLast()).toBe('not there, the other file');
  expect(rig.conv.queue).toEqual([]);
  model.release();
  await turn;
  expect(JSON.stringify(messages(1))).not.toContain('not there');
});

test('⇥ on the empty field holds the queued message for the turn\'s end', async () => {
  const { model, rig, turn, messages } = await heldTurn([{ text: 'Now the other file.' }]);
  expect(rig.conv.toggleHoldLast()).toBe(true);
  expect(rig.conv.queueWait(rig.conv.queue, 0)).toBe('end');
  model.release();
  await turn;
  await rig.until(() => rig.conv.lastAnswer() === 'Now the other file.');
  await rig.idle();
  // Not delivered mid-turn: the turn ended, then it went out as a turn of its own.
  expect(JSON.stringify(messages(1))).not.toContain('not there');
  expect(model.requests).toHaveLength(3);
  // The drain turn's wire message is framed as written while the previous turn ran; the
  // row and the journal keep the line as typed.
  const wire = messages(2).at(-1)! as Msg;
  expect(wire.role).toBe('user');
  expect(String(wire.content)).toContain('not there, the other file');
  expect(String(wire.content)).toContain('previous turn was running');
  expect(String(wire.content)).not.toContain('steered in mid-turn');
  const row = rig.conv.messages.find((m) => m.role === 'user' && m.content === 'not there, the other file');
  expect(row).toEqual({ role: 'user', content: 'not there, the other file' });
  expect(rig.journal().filter((e) => e.t === 'row' && e.text === 'not there, the other file')).toHaveLength(1);
  expect(JSON.stringify(rig.conv.messages)).not.toContain('previous turn');
  expect(JSON.stringify(rig.journal())).not.toContain('previous turn');
  // And it stays in the model's history for the next turn, framed as it was sent.
  model.script([{ text: 'ok' }]);
  await rig.conv.send('next');
  expect(JSON.stringify(messages(3))).toContain('not there, the other file');
  expect(JSON.stringify(messages(3))).toContain('previous turn was running');
});

test('a message typed while idle goes out unframed', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const rig = conversationRig(model);
  await rig.conv.send('do the long thing');
  const wire = (rig.messages(0) as Msg[]).at(-1)!;
  expect(wire.role).toBe('user');
  expect(wire.content).toBe('do the long thing');
});

test('⇥ holds only the message it was pressed on: a correction typed after it reaches the model mid-turn while the note waits', async () => {
  const { model, rig, turn, messages } = await heldTurn([{ text: 'Now the note.' }]);
  rig.conv.toggleHoldLast(); // this note, and only it, goes at the turn's end
  rig.conv.enqueue('and a correction');
  expect(rig.conv.queueWait(rig.conv.queue, 0)).toBe('end');
  expect(rig.conv.queueWait(rig.conv.queue, 1)).toBe('step');
  model.release();
  await turn;
  await rig.until(() => rig.conv.lastAnswer() === 'Now the note.');
  // The correction went in at the boundary, the held note waited for the end.
  const wire = messages(1).at(-1)!;
  expect(wire.role).toBe('user');
  expect(String(wire.content).startsWith('and a correction\n\n')).toBe(true);
  expect(String(wire.content)).toContain('steered in mid-turn');
  expect(String(wire.content)).not.toContain('previous turn');
  expect(JSON.stringify(messages(1))).not.toContain('not there');
  // The note waited for the end: its own turn, framed the other way.
  const note = messages(2).at(-1)!;
  expect(note.role).toBe('user');
  expect(String(note.content).startsWith('not there, the other file\n\n')).toBe(true);
  expect(String(note.content)).toContain('previous turn was running');
  expect(String(note.content)).not.toContain('steered in mid-turn');
});

test('a message naming an image waits for the turn\'s end, and keeps the ones behind it waiting — the line says so for each', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-queue-img-'));
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, png(40, 30));
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }, { hold: true }], [{ text: 'Adjusted.' }], [{ text: 'Saw the image.' }], [{ text: 'And the rest.' }]);
  const rig = conversationRig(model);
  const messages = (i: number) => rig.messages(i) as Msg[];
  const turn = rig.conv.send('do the long thing');
  await rig.until(() => model.held);
  const loaded = loadImageFile(shot, rig.root, 10 * 1024 * 1024);
  if (!loaded.ok) throw new Error(loaded.error);
  const n = rig.conv.attachImage(loaded);
  rig.conv.enqueue(`${imageToken(n)} look at this`);
  rig.conv.enqueue('and then this');
  expect(rig.conv.queueWait(rig.conv.queue, 0)).toBe('image');
  expect(rig.conv.queueWait(rig.conv.queue, 1)).toBe('behind');
  model.release();
  await turn;
  await rig.until(() => rig.conv.lastAnswer() === 'And the rest.');
  // Nothing was delivered mid-turn: the image and the text after it went in order after.
  expect(JSON.stringify(messages(1))).not.toContain('look at this');
  expect(JSON.stringify(messages(1))).not.toContain('and then this');
  // Each went out as its own turn, framed as written while the previous turn ran.
  const first = messages(2).at(-1)!;
  expect(first.role).toBe('user');
  // The text part is the frame; the image rides beside it as a part of its own.
  const firstParts = first.content as { type: string; text?: string }[];
  expect(firstParts[0]!.type).toBe('text');
  expect(firstParts[0]!.text!.startsWith(`${imageToken(n)} look at this\n\n`)).toBe(true);
  expect(firstParts[0]!.text).toContain('previous turn was running');
  expect(firstParts[0]!.text).not.toContain('steered in mid-turn');
  expect(firstParts.some((p) => p.type === 'image_url')).toBe(true);
  const second = messages(3).at(-1)!;
  expect(second.role).toBe('user');
  expect(String(second.content)).toContain('previous turn was running');
  expect(String(second.content)).not.toContain('steered in mid-turn');
});

test('a stopped turn\'s queue comes back into the field as typed, with no frame in it', async () => {
  const { model, rig, turn } = await heldTurn();
  rig.conv.enqueue('and then this');
  expect(rig.conv.stop('^c')).toBe(true);
  await turn;
  expect(rig.conv.lastEnd).toMatchObject({ outcome: 'stopped' });
  await rig.idle();
  // No drain turn ran: the person decides what to send.
  expect(model.requests).toHaveLength(1);
  const texts = rig.conv.restoreQueue()!;
  expect(texts).toEqual(['not there, the other file', 'and then this']);
  expect(texts.join('\n\n')).not.toContain('Written while');
});
