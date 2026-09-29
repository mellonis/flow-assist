// The one policy table (src/assistant/confirm-policy.ts): for each policy, one run that
// makes one write — whether `onToolStart` fired and asked, how `onToolRun` saw the call,
// what the journal's `confirm` line says, and whether the write happened.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentChat, type ChatRoundResult, type ToolRun } from '../agent.ts';
import { confirmFor, type ConfirmPolicy } from '../confirm-policy.ts';
import { Conversation } from '../conversation.ts';
import { readJournal } from '../journal.ts';
import { journalPath } from '../sessions.ts';
import { createShellState } from '../shell.ts';
import { assembleToolRegistry } from '../../loader/tools.ts';
import { fakeDeps } from './conversation-deps.ts';

const MAKE = { name: 'run_command', arguments: JSON.stringify({ command: 'echo made > made.txt' }) };
const CONFIG_SET = { name: 'config_set', arguments: JSON.stringify({ key: 'ui.verbs', value: '["Pondering"]', scope: 'session' }) };

async function row(policy: ConfirmPolicy, opts: { call?: { name: string; arguments: string }; person?: boolean; autoAll?: boolean; task?: string } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-policy-')));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-policy-root-')));
  const deps = fakeDeps({ sessionsDir: () => dir });
  const config = deps.config();
  config.shell = { roots: [root], ...(opts.autoAll ? { autoRun: true } : {}) };
  assembleToolRegistry({ plugins: [], config, repo: { list: async () => [] } as never });
  const conv = new Conversation(deps);
  if (opts.autoAll) conv.setAutoMode('all');
  const journalId = conv.journal({ t: 'row', role: 'user', text: 'make the file' }, { person: true });
  // A y/n that parks is answered as the person's key would answer it.
  let parked = 0;
  conv.on('confirm', (ev) => { if (ev.request) { parked++; setTimeout(() => conv.answerConfirm(opts.person !== false), 0); } });
  const call = opts.call ?? MAKE;
  let n = 0;
  const round = async (): Promise<ChatRoundResult> => (n++ === 0
    ? { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call_1', ...call }] }
    : { content: 'done', reasoning: '', finishReason: 'stop', toolCalls: [] });
  const starts: { name: string; confirm: boolean }[] = [];
  const runs: ToolRun[] = [];
  await agentChat([{ role: 'user', content: 'make the file' }], {
    chatRound: round as never,
    toolCtx: { config, shell: createShellState(() => config as never, root) } as never,
    confirmWrite: confirmFor(policy, { conv, journalId, ...(opts.task ? { task: opts.task } : {}) }),
    onToolStart: (c) => starts.push({ name: c.name, confirm: c.confirm }),
    onToolRun: (r) => runs.push(r),
  });
  const confirms = (readJournal(journalPath(conv.homes.get(journalId)!, journalId)) ?? []).filter((e) => e.t === 'confirm');
  return { starts, runs, confirms, parked, made: fs.existsSync(path.join(root, 'made.txt')) };
}

test('ask: the y/n parks, the person\'s yes runs the write, journaled by: person', async () => {
  const r = await row({ kind: 'ask' });
  expect(r.starts).toEqual([{ name: 'run_command', confirm: true }]);
  expect(r.parked).toBe(1);
  expect(r.runs.map((x) => x.outcome)).toEqual(['applied']);
  expect(r.confirms).toMatchObject([{ id: 'call_1', name: 'run_command', answer: 'yes', by: 'person' }]);
  expect(r.made).toBe(true);
});

test('ask: the person\'s no declines it, journaled by: person', async () => {
  const r = await row({ kind: 'ask' }, { person: false });
  expect(r.runs.map((x) => x.outcome)).toEqual(['declined']);
  expect(r.confirms).toMatchObject([{ answer: 'no', by: 'person' }]);
  expect(r.made).toBe(false);
});

test('ask under the auto mode all with shell.autoRun: nothing parks, the write runs, journaled by: auto', async () => {
  const r = await row({ kind: 'ask' }, { autoAll: true });
  expect(r.starts).toEqual([{ name: 'run_command', confirm: true }]);
  expect(r.parked).toBe(0);
  expect(r.runs.map((x) => x.outcome)).toEqual(['applied']);
  expect(r.confirms).toMatchObject([{ answer: 'yes', by: 'auto' }]);
  expect(r.made).toBe(true);
});

test('always-no: the call is announced as asking, declined, journaled by: background with the task\'s label', async () => {
  const r = await row({ kind: 'always-no' }, { task: 'clock' });
  expect(r.starts).toEqual([{ name: 'run_command', confirm: true }]);
  expect(r.runs.map((x) => x.outcome)).toEqual(['declined']);
  expect(String(r.runs[0]!.detail)).toContain('declined');
  expect(r.confirms).toMatchObject([{ name: 'run_command', answer: 'no', by: 'background', task: 'clock' }]);
  expect(r.made).toBe(false);
});

test('none: no confirmWrite — declined before it starts, "cannot ask the person", no onToolStart, no confirm line', async () => {
  const r = await row({ kind: 'none' });
  expect(r.starts).toEqual([]);
  expect(r.runs.map((x) => x.outcome)).toEqual(['declined']);
  expect(String(r.runs[0]!.detail)).toContain('cannot ask the person');
  expect(r.confirms).toEqual([]);
  expect(r.made).toBe(false);
});

test('allow-writes: the host\'s shell write runs and is said; config_set is still declined and says nothing', async () => {
  const said: string[] = [];
  const r = await row({ kind: 'allow-writes', say: (l) => said.push(l) });
  expect(r.starts).toEqual([{ name: 'run_command', confirm: true }]);
  expect(r.runs.map((x) => x.outcome)).toEqual(['applied']);
  expect(said).toEqual(['[write] ! echo made > made.txt']);
  expect(r.confirms).toEqual([]);
  expect(r.made).toBe(true);
  const saidConfig: string[] = [];
  const c = await row({ kind: 'allow-writes', say: (l) => saidConfig.push(l) }, { call: CONFIG_SET });
  expect(c.runs.map((x) => x.outcome)).toEqual(['declined']);
  expect(saidConfig).toEqual([]);
});

test('caller: the plugin\'s own answer decides, journaled by: plugin (by: background under a task\'s label)', async () => {
  const yes = await row({ kind: 'caller', confirm: () => true });
  expect(yes.runs.map((x) => x.outcome)).toEqual(['applied']);
  expect(yes.confirms).toMatchObject([{ answer: 'yes', by: 'plugin' }]);
  expect(yes.confirms[0]!.task).toBeUndefined();
  expect(yes.made).toBe(true);
  const no = await row({ kind: 'caller', confirm: async () => false });
  expect(no.runs.map((x) => x.outcome)).toEqual(['declined']);
  expect(no.confirms).toMatchObject([{ answer: 'no', by: 'plugin' }]);
  const task = await row({ kind: 'caller', confirm: () => false }, { task: 'clock' });
  expect(task.confirms).toMatchObject([{ answer: 'no', by: 'background', task: 'clock' }]);
});
