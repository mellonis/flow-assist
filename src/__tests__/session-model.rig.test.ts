// A session records the model it runs: the field is saved with the session and read
// back into the conversation that opens it. A conversation on the scripted model, no App.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { loadSession, saveSession, type Session } from '../assistant/sessions.ts';
import { closeRigs, conversationRig } from './helpers/conversation';
import { homeIn } from './helpers/session-files';
import { ScriptedModel } from './helpers/scripted';

afterEach(() => closeRigs());

test('a session records the model it runs, and opening it back brings it', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { model: 'default-model', models: { 'big-model': { contextWindow: 512000 } } } });
  rig.conv.model = 'big-model';
  await rig.conv.send('hello');
  // The conversation the session was in goes as the chat's does on a switch: saved and
  // put away, its lock given up — so `rig.open` takes the session back from its file.
  rig.conv.save();
  const id = rig.conv.sessionId!;
  rig.conv.releaseLock();
  rig.conv.close('park');
  rig.open(id);
  expect(rig.conv.model).toBe('big-model');
  await rig.conv.send('again');
  expect(model.requests.at(-1)?.model).toBe('big-model');
});

test('a session with no model of its own runs ai.model, and its file carries no model key', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { model: 'default-model' } });
  await rig.conv.send('hello');
  expect(rig.conv.model).toBeUndefined();
  // The request carries ai.model — what a session without its own model runs.
  expect(model.requests.at(-1)?.model).toBe('default-model');
  rig.conv.save();
  const id = rig.conv.sessionId!;
  const file = path.join(homeIn(rig.sessionsDir!, id), `${id}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  expect(Object.hasOwn(raw, 'model')).toBe(false);
});

test('the writer trims what a conversation holds as its model', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { model: 'default-model' } });
  rig.conv.model = '  big-model  ';
  await rig.conv.send('hello');
  rig.conv.save();
  const id = rig.conv.sessionId!;
  const file = path.join(homeIn(rig.sessionsDir!, id), `${id}.json`);
  let raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  expect(raw.model).toBe('big-model'); // a padded id is saved as the id it names
  rig.conv.model = '   ';
  rig.conv.save();
  raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  // Whitespace is no model at all, as on the read — never a blank name saved for good.
  expect(Object.hasOwn(raw, 'model')).toBe(false);
});

test('a model the catalogue does not name still runs, on the window ai.contextWindow stands for', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { model: 'default-model', contextWindow: 90000 } });
  rig.conv.model = 'unlisted-model';
  await rig.conv.send('hello');
  expect(model.requests.at(-1)?.model).toBe('unlisted-model');
  expect(rig.conv.contextWindow()).toBe(90000);
});

test('a model a file holds that the catalogue does not name opens from the file and runs it', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { model: 'default-model', contextWindow: 90000 } });
  rig.conv.model = 'unlisted-model';
  await rig.conv.send('hello');
  const id = rig.conv.sessionId!;
  // Saved by the conversation, put away, and taken back from its file: the id survives
  // the round-trip even though no catalogue names it.
  rig.conv.save();
  rig.conv.releaseLock();
  rig.conv.close('park');
  rig.open(id);
  expect(rig.conv.model).toBe('unlisted-model');
  await rig.conv.send('again');
  expect(model.requests.at(-1)?.model).toBe('unlisted-model');
  // Its window falls back to what `ai.contextWindow` stands for, never refused.
  expect(rig.conv.contextWindow()).toBe(90000);
});

test('a model a file holds that is not a string reads as no model', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { model: 'default-model' } });
  await rig.conv.send('hello');
  rig.conv.save();
  const id = rig.conv.sessionId!;
  rig.conv.releaseLock();
  rig.conv.close('park');
  // A hand edit after the conversation's last write: the reader takes the field on its
  // own terms.
  const dir = homeIn(rig.sessionsDir!, id);
  saveSession(dir, { ...loadSession(dir, id)!, model: 123 } as unknown as Session);
  rig.open(id);
  expect(rig.conv.model).toBeUndefined();
});

test('a model a file holds as whitespace reads as no model', async () => {
  const model = new ScriptedModel();
  const rig = conversationRig(model, { ai: { model: 'default-model' } });
  await rig.conv.send('hello');
  rig.conv.save();
  const id = rig.conv.sessionId!;
  rig.conv.releaseLock();
  rig.conv.close('park');
  // Whitespace names no model: the frame says none and the request runs ai.model, rather
  // than a blank name carried through the file and onto every request for good.
  const dir = homeIn(rig.sessionsDir!, id);
  saveSession(dir, { ...loadSession(dir, id)!, model: '  ' } as unknown as Session);
  rig.open(id);
  expect(rig.conv.model).toBeUndefined();
  await rig.conv.send('again');
  expect(model.requests.at(-1)?.model).toBe('default-model');
});
