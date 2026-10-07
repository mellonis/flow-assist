// The model's job-offloading tool is `subagent`. A saved session whose history holds calls
// under the name `background` still sends cleanly (AGENTS.md (What the model can do)).
import { afterEach, expect, test } from 'bun:test';
import { loadSession, saveSession } from '../assistant/sessions.ts';
import { ScriptedModel, type RecordedRequest } from './helpers/scripted';
import { closeRigs, conversationRig, type Sent } from './helpers/conversation';
import { homeIn } from './helpers/session-files';

afterEach(() => closeRigs());

const toolNames = (req: RecordedRequest): string[] =>
  ((req.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);

async function offered(): Promise<string[]> {
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const rig = conversationRig(model);
  await rig.conv.send('hi');
  return toolNames(model.requests[0]!);
}

test('a saved session with `background` calls in its history sends its next request, the old calls kept', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'It is late.' }], [{ text: 'Still fine.' }]);
  const rig = conversationRig(model);
  await rig.conv.send('what time');
  rig.conv.save();
  const id = rig.conv.sessionId;
  rig.conv.releaseLock();
  rig.conv.close('park');
  // The history with the call and its result under the name `background`.
  const dir = homeIn(rig.sessionsDir!, id);
  const saved = loadSession(dir, id)!;
  const renamed = JSON.parse(JSON.stringify(saved).replaceAll('"datetime"', '"background"'));
  expect(JSON.stringify(renamed.api)).toContain('"name":"background"');
  saveSession(dir, renamed);

  const opened = rig.open(id);
  await opened.send('and now?');
  const last = model.requests.at(-1)!;
  const calls = (rig.sent() as Sent[]).flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name);
  expect(calls).toEqual(['background']);
  expect(rig.sent().some((m) => m.role === 'tool')).toBe(true);
  expect(rig.sent().at(-1)?.content).toBe('and now?');
  expect(opened.lastAnswer()).toBe('Still fine.');
  // The tool on offer carries the name `subagent` only.
  expect(toolNames(last)).toContain('subagent');
  expect(toolNames(last)).not.toContain('background');
});

test('the tool is offered as `subagent` and `background` is not offered', async () => {
  const names = await offered();
  expect(names).toContain('subagent');
  expect(names).not.toContain('background');
});
