// The inbox: what arrives from outside the conversation — a background task's result —
// never enters a running turn. It is taken when the turn ends: every waiting item lands
// as its row, and the person's queued message carries them, or ONE follow-up turn runs
// for all of them. A pending y/n holds it; a draft and a closed chat do not.
// `ai.backgroundFollowUp: false` keeps the rows and spends no turn.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptedConfigPath, guardConfigFiles, hostStateDir, loadConfig, resetSessionConfig, unguardConfigFiles } from '../config/load.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import type { Make } from '../loader/plugin';

const realFetch = globalThis.fetch;
const local = () => path.join(hostStateDir(), 'config.local.json');
afterEach(() => {
  globalThis.fetch = realFetch;
  post = undefined;
  unguardConfigFiles();
  resetSessionConfig();
  fs.rmSync(local(), { force: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
  for (const f of fs.readdirSync(hostStateDir())) if (f.includes('.rejected-')) fs.rmSync(path.join(hostStateDir(), f));
});

const settleUntil = async (ok: () => boolean, n = 300) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
// Past the inbox's own 400 ms tick: a turn it would start has started by then.
const pastTick = () => new Promise((r) => setTimeout(r, 500)).then(() => settle(10));
type Msg = { role: string; content: unknown; tool_calls?: unknown[] };
const messages = (model: ScriptedModel, i: number) => (model.requests[i] as { messages: Msg[] }).messages;
const text = (m: Msg) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
const fieldRow = (frame: string) => frame.split('\n').filter((r) => r.includes('› ')).at(-1) ?? '';

// The chat's own channel for a result from outside, taken from a tool's ctx: `courier_arm`
// keeps it, `courier_post` posts three results from inside its call — in the middle of
// a round, between the call and its result.
let post: ((text: string) => void) | undefined;
const courier = (make: Make) => make('courier', {
  tools: [{
    id: 'courier',
    tools: [
      { type: 'function', function: { name: 'courier_arm', description: 'Arm the courier.', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'courier_post', description: 'Post three results.', parameters: { type: 'object', properties: {} } } },
    ],
    exec: async (name: string, _args: unknown, ctx: Record<string, unknown>) => {
      post = ctx.postToChat as (t: string) => void;
      if (name === 'courier_post') for (const k of ['a', 'b', 'c']) post(`${k} finished:\nresult ${k.toUpperCase()}`);
      return 'ok';
    },
  }],
} as never);

const AI = { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all' };
const boot = (model: ScriptedModel, extra: Record<string, unknown> = {}) => bootApp(model, 110, 34, (make) => [courier(make)], extra);

// A first turn that arms the courier and answers; the chat is left idle and open.
async function armed(extra: Record<string, unknown> = {}) {
  const model = new ScriptedModel();
  model.script([{ tool: 'courier_arm', args: {} }], [{ text: 'Armed.' }]);
  const ui = await boot(model, extra);
  await ui.press('F');
  await ui.type('arm it');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Armed.'));
  await settle(10);
  expect(typeof post).toBe('function');
  expect(model.requests).toHaveLength(2);
  return { model, ui };
}

test('three results arriving during one turn land after it, and ONE follow-up turn reads all three', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'courier_post', args: {} }],
    [{ text: 'Working on it.' }],
    [{ text: 'All three are in.' }],
  );
  const ui = await boot(model);
  await ui.press('F');
  await ui.type('go');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('All three are in.'));
  await pastTick();

  // The round after the call carries the call's result and nothing of the inbox: no
  // result stands between a call and its result, nor enters the running turn at all.
  const round2 = messages(model, 1);
  expect(round2.at(-1)!.role).toBe('tool');
  expect(round2.at(-2)!.tool_calls?.length).toBe(1);
  expect(round2.some((m) => /finished:/.test(text(m)))).toBe(false);

  // One turn after it — not three — whose request carries all three, after the answer.
  expect(model.requests).toHaveLength(3);
  const follow = messages(model, 2);
  const answer = follow.findIndex((m) => m.role === 'assistant' && text(m).includes('Working on it.'));
  const at = ['A', 'B', 'C'].map((k) => follow.findIndex((m) => m.role === 'user' && text(m).includes(`result ${k}`)));
  expect(answer).toBeGreaterThan(-1);
  for (const i of at) expect(i).toBeGreaterThan(answer);
  expect(at).toEqual([...at].sort((x, y) => x - y));
  // Framed as a task's result, as a result row always is — never as the person's words.
  expect(text(follow[at[0]!]!)).toMatch(/^a finished:\nresult A$/);

  // Each lands as its own row, under the answer; the follow-up's answer under them.
  const frame = ui.backend.lastFrame;
  expect(frame.match(/◆ /g)?.length).toBe(3);
  expect(frame.indexOf('Working on it.')).toBeLessThan(frame.indexOf('result A'));
  expect(frame.indexOf('result C')).toBeLessThan(frame.indexOf('All three are in.'));
  ui.app.unmount();
});

test('a result arriving while the person has a message queued is read in that message\'s turn, with no extra turn', async () => {
  const { model, ui } = await armed();
  // The answer round holds: the person queues a message and a result arrives meanwhile.
  model.script([{ hold: true }, { text: 'First answer.' }], [{ text: 'Read both.' }]);
  await ui.type('next thing');
  await ui.press('return');
  await settle(10);
  await ui.type('and also this');
  await ui.press('return');
  post!('d finished:\nresult D');
  await settle(10);
  expect(ui.backend.lastFrame).not.toContain('result D');
  model.release();
  await settleUntil(() => ui.backend.lastFrame.includes('Read both.'));
  await pastTick();

  expect(model.requests).toHaveLength(4);
  const sent = messages(model, 3);
  const result = sent.findIndex((m) => m.role === 'user' && text(m).includes('result D'));
  const mine = sent.findIndex((m) => m.role === 'user' && text(m) === 'and also this');
  expect(result).toBeGreaterThan(-1);
  expect(mine).toBe(sent.length - 1);
  expect(result).toBeLessThan(mine);
  const frame = ui.backend.lastFrame;
  expect(frame.indexOf('First answer.')).toBeLessThan(frame.indexOf('result D'));
  expect(frame.indexOf('result D')).toBeLessThan(frame.indexOf('and also this'));
  ui.app.unmount();
});

test('a draft in the field does not hold a result: it lands, the follow-up turn runs, and the draft stays', async () => {
  const { model, ui } = await armed();
  model.script([{ text: 'Noted the result.' }]);
  await ui.type('half a th');
  post!('e finished:\nresult E');
  await settleUntil(() => ui.backend.lastFrame.includes('Noted the result.'));
  await pastTick();
  expect(model.requests).toHaveLength(3);
  expect(text(messages(model, 2).at(-1)!)).toBe('e finished:\nresult E');
  expect(ui.backend.lastFrame).toContain('◆ ');
  expect(fieldRow(ui.backend.lastFrame)).toContain('half a th');
  ui.app.unmount();
});

test('a closed chat does not hold a result: the turn runs, and the unread count and the alert say so', async () => {
  const { model, ui } = await armed();
  model.script([{ text: 'Noted while closed.' }]);
  await ui.press('escape', 'escape');
  expect(ui.backend.lastFrame).not.toContain('Flow Assist');
  post!('f finished:\nresult F');
  await settleUntil(() => model.requests.length === 3);
  await pastTick();
  expect(model.requests).toHaveLength(3);
  expect(ui.backend.notifications).toEqual([{ title: 'flow-assist', body: 'f finished:' }]);
  await settleUntil(() => /◆ 1 new/.test(ui.backend.lastFrame), 400);
  expect(ui.backend.lastFrame).toMatch(/◆ 1 new/);
  await ui.press('F');
  expect(ui.backend.lastFrame).toContain('result F');
  expect(ui.backend.lastFrame).toContain('Noted while closed.');
  ui.app.unmount();
});

test('a pending y/n holds the inbox; the result lands and its turn runs once it is answered', async () => {
  fs.mkdirSync(hostStateDir(), { recursive: true });
  fs.rmSync(acceptedConfigPath(), { force: true });
  fs.writeFileSync(local(), '{}');
  loadConfig();
  guardConfigFiles();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-inbox-root-')));
  const { model, ui } = await armed({ shell: { roots: [root] } });
  // The person's own command rewrites the settings: the chat asks, idle.
  await ui.type('!');
  await ui.type(`printf '%s' '{"shell":{"autoRun":true}}' > '${local()}'`);
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('changed outside flow-assist'));
  model.script([{ text: 'Saw it after the y/n.' }]);
  post!('g finished:\nresult G');
  await pastTick();
  expect(ui.backend.lastFrame).not.toContain('result G');
  expect(model.requests).toHaveLength(2);
  await ui.press('n');
  await settleUntil(() => ui.backend.lastFrame.includes('Saw it after the y/n.'));
  await pastTick();
  expect(model.requests).toHaveLength(3);
  expect(text(messages(model, 2).at(-1)!)).toBe('g finished:\nresult G');
  ui.app.unmount();
});

test('a turn stopped with Esc lands what waited as rows and starts no turn for it', async () => {
  const { model, ui } = await armed();
  model.script([{ text: 'Sta' }, { hold: true }, { text: 'rted.' }]);
  await ui.type('long one');
  await ui.press('return');
  await settle(10);
  post!('h finished:\nresult H');
  await ui.press('escape');
  await settleUntil(() => ui.backend.lastFrame.includes('result H'));
  await pastTick();
  expect(ui.backend.lastFrame).toContain('stopped (Esc)');
  expect(model.requests).toHaveLength(3);
  ui.app.unmount();
});

test('ai.backgroundFollowUp false keeps rows only: every result lands, no turn is spent on them', async () => {
  const { model, ui } = await armed({ ai: { ...AI, backgroundFollowUp: false } });
  post!('i finished:\nresult I');
  post!('j finished:\nresult J');
  await settleUntil(() => ui.backend.lastFrame.includes('result J'));
  await pastTick();
  expect(ui.backend.lastFrame).toContain('result I');
  expect(model.requests).toHaveLength(2);
  // They ride in the history of the person's next message.
  model.script([{ text: 'ok' }]);
  await ui.type('what came back');
  await ui.press('return');
  await settleUntil(() => model.requests.length === 3);
  const sent = messages(model, 2);
  expect(sent.findIndex((m) => text(m).includes('result I'))).toBeLessThan(sent.findIndex((m) => text(m) === 'what came back'));
  ui.app.unmount();
});
