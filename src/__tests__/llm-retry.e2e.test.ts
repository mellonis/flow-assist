// A model request that fails for a reason that passes waits and is made again, in the
// real app on the scripted model: the status line of a session's turn counts the wait
// down, Esc during it stops the turn (it does not fail), and a subagent's run survives
// the failure. The wait and its ticks are driven by hand through `retryClock`.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retryClock } from '../assistant/llm-retry.ts';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';
import { listTree } from './helpers/session-files';

const realFetch = globalThis.fetch;
const realClock = { ...retryClock };
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(retryClock, realClock);
});

const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';

// The clock: a wait ends when the test says so (or when its signal aborts); the
// countdown's ticks fire when the test says so, with the time moved by hand.
let time = 0;
let endWait: (() => void) | null = null;
let waits: number[] = [];
let tick: (() => void) | null = null;
beforeEach(() => {
  time = 1_000_000;
  endWait = null;
  waits = [];
  tick = null;
  retryClock.now = () => time;
  retryClock.sleep = (ms, signal) => new Promise<void>((resolve, reject) => {
    waits.push(ms);
    endWait = resolve;
    signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
  });
  retryClock.every = (fn) => { tick = fn; return () => { if (tick === fn) tick = null; }; };
});

// The scripted model behind a fetch that answers the first request `fail` accepts with a
// 429 (and a `Retry-After` of 3 s).
function limited(model: ScriptedModel, fail: (body: { messages: { role: string; content?: unknown }[] }) => boolean) {
  model.install();
  const inner = globalThis.fetch;
  let failed = false;
  const requests: string[] = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (!failed && fail(body)) {
      failed = true;
      requests.push('429');
      return new Response('{"error":{"message":"slow down"}}', { status: 429 });
    }
    requests.push('ok');
    return inner(url as never, init);
  }) as typeof fetch;
  return requests;
}

const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), `fa-retry-${process.pid}-`));
// How the session's journal says its turns ended.
const ends = (dir: string) => listTree(dir).filter((n) => n.endsWith('.log.jsonl'))
  .flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .filter((ev) => ev.t === 'end');

async function boot(model: ScriptedModel, extra: Record<string, unknown> = {}, dir = dirOf()) {
  const ui = await bootApp(model, 140, 34, undefined, { sessions: { dir }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false, ...extra } }, { toastMs: 10_000 });
  await ui.press('F');
  return ui;
}

test("a session's status line counts the wait down each second, and the answer follows the repeat", async () => {
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'Back again.' }]);
  const ui = await boot(model);
  const requests = limited(model, () => true);
  await ui.type('hello');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('retry 1/10'));
  expect(frameOf(ui)).toContain('LLM 429 · retry 1/10 in 3 s');
  expect(waits).toEqual([3000]);

  time += 1000;
  tick!();
  await settleUntil(() => frameOf(ui).includes('in 2 s'));
  expect(frameOf(ui)).toContain('LLM 429 · retry 1/10 in 2 s');
  time += 2000;
  tick!();
  await settleUntil(() => frameOf(ui).includes('in 0 s'));
  expect(frameOf(ui)).toContain('LLM 429 · retry 1/10 in 0 s');

  // The wait over, the label goes at once: the repeat is in flight (held here), and the
  // line must not keep saying it is waiting.
  endWait!();
  await settleUntil(() => model.held);
  await settle(6);
  expect(model.held).toBe(true);
  expect(frameOf(ui)).not.toContain('retry 1/10');
  model.release();
  await settleUntil(() => frameOf(ui).includes('Back again.'));
  expect(frameOf(ui)).toContain('Back again.');
  expect(requests).toEqual(['429', 'ok']);
  expect(tick).toBeNull();
  ui.app.unmount();
});

test('Esc during the wait stops the turn: the journal says stopped, not failed, and the chat takes the next message', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Second time lucky.' }]);
  const dir = dirOf();
  const ui = await boot(model, {}, dir);
  const requests = limited(model, () => true);
  await ui.type('hello');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('retry 1/10'));
  await ui.press('escape');
  await settleUntil(() => ends(dir).length === 1);
  expect(ends(dir)).toHaveLength(1);
  expect(ends(dir)[0]).toMatchObject({ stopped: 'Esc' });
  expect(ends(dir)[0].failed).toBeUndefined();
  expect(frameOf(ui)).not.toContain('retry 1/10');
  expect(frameOf(ui)).not.toContain('slow down');
  expect(requests).toEqual(['429']);
  expect(tick).toBeNull();

  await ui.type('again');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('Second time lucky.'));
  expect(frameOf(ui)).toContain('Second time lucky.');
  ui.app.unmount();
});

test('ai.retries 0 makes one request and the turn fails with the provider\'s words', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'never' }]);
  const ui = await boot(model, { retries: 0 });
  const requests = limited(model, () => true);
  await ui.type('hello');
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes('LLM 429'));
  expect(frameOf(ui)).toContain('LLM 429');
  expect(frameOf(ui)).not.toContain('gave up');
  expect(requests).toEqual(['429']);
  expect(waits).toEqual([]);
  ui.app.unmount();
});

test("a subagent's run survives a 429 and finishes; its wait is a log line, not the session's status line", async () => {
  const model = new ScriptedModel();
  const child = model.when((req) => firstUser(req).includes('WAIT-ME'));
  child.script([{ text: 'Found it after the wait.' }]);
  const ui = await boot(model);
  const requests = limited(model, (body) => firstUser(body as never).includes('WAIT-ME'));
  await ui.type('/subagent WAIT-ME find the test');
  await ui.press('return');
  await settleUntil(() => waits.length === 1);
  await settle(6);
  expect(waits).toEqual([3000]);
  expect(frameOf(ui)).not.toContain('retry 1/10');
  expect(tick).toBeNull();

  endWait!();
  await settleUntil(() => frameOf(ui).includes('Found it after the wait.'));
  expect(frameOf(ui)).toContain('Found it after the wait.');
  expect(requests).toEqual(['429', 'ok']);
  ui.app.unmount();
});
