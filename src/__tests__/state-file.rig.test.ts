// A wait for the person reaches the session's state file: a live conversation — a real one,
// with its own session on disk and only the network replaced — is mapped by `stateInputOf`
// and mirrored by the writer beside `<id>.json`, so a watcher outside the host reads
// `waiting` and the tool it waits on. The file stops saying so once the person answers.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { startStateFiles, stateSources } from '../assistant/state-file.ts';
import { ScriptedModel } from './helpers/scripted.ts';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation.ts';
import { homeIn } from './helpers/session-files.ts';

// What the file holds, as a watcher reads it: only the fields this test speaks about.
interface Shown {
  version: number;
  id: string;
  title: string;
  pid: number;
  status: string;
  tree: Array<{ key: string; kind: string; status: string; latest: string }>;
}

const writers: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const w of writers.splice(0)) w.stop();
  closeRigs();
});

// The writer as the chat wires it: the live sessions alone — a task or a subagent is a node
// of its session's tree, never a session — each in its own directory, beside `<id>.json`.
const mirror = (rig: Rig) =>
  startStateFiles({
    dir: rig.sessionsDir,
    dirOf: (i) => rig.registry.bySession(i.id)?.homes.get(i.id) ?? rig.sessionsDir,
    sources: stateSources(rig.registry, process.pid),
  });

const stateOf = (home: string, id: string): Shown =>
  JSON.parse(fs.readFileSync(path.join(home, `${id}.state.json`), 'utf8')) as Shown;

test('a y/n waiting for the person shows in the session state file', async () => {
  const model = new ScriptedModel();
  // A command is a write: it waits for the y/n before it runs.
  model.script([{ tool: 'run_command', args: { command: 'echo hi' } }], [{ text: 'done' }]);
  const rig = conversationRig(model);
  const turn = rig.conv.send('go');
  await rig.until(() => rig.conv.confirm !== null);
  const id = rig.conv.sessionId;
  const home = homeIn(rig.sessionsDir!, id);
  // Beside the session file, which the first message's save writes.
  await rig.until(() => fs.existsSync(path.join(home, `${id}.json`)));

  const w = mirror(rig);
  writers.push(w);
  w.flushNow();

  const waiting = stateOf(home, id);
  expect(waiting).toMatchObject({ version: 1, id, status: 'waiting', pid: process.pid });
  // The chat's own row: the tool it waits on, and the title from what the person said.
  expect(waiting.tree[0]).toMatchObject({ key: 'root', kind: 'chat', status: 'waiting', latest: 'run_command — y/n' });
  expect(waiting.title).toBe('go');
  // The wait is the session's alone: nothing runs below it.
  expect(waiting.tree).toHaveLength(1);

  // Answered and done: the same file no longer says it waits.
  rig.answerNext(true);
  await turn;
  w.flushNow();
  expect(stateOf(home, id).tree[0]).toMatchObject({ status: 'idle', latest: '' });
  expect(stateOf(home, id).status).not.toBe('waiting');
});
