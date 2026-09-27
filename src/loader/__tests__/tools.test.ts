import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assembleToolRegistry } from '../tools';
import { hostConfigSchema } from '../../config/schema.js';
import { bgActiveCount } from '../tools-core.js';
import { makeFactory } from '../plugin';
import { identityToken } from '../../runtime/plugin-identity.js';
import { addFact, readFacts } from '../../assistant/memory-store.js';
import { workspaceDir } from '../../assistant/workspace.js';

test('assembles built-in core + host + plugin groups, deduped by name', () => {
  const make = makeFactory({});
  const plugins = [
    make('tracker', { tools: [{ id: 'tracker', alwaysOn: false, tools: [{ type: 'function', function: { name: 'tracker:get_issue', description: '', parameters: { type: 'object', properties: {} } } }], exec: async () => '{}' }] }),
  ];
  const reg = assembleToolRegistry({ plugins, config: {}, repo: { list: async () => [] } as any });
  const names = reg.tools.map(t => t.function.name);
  expect(names).toContain('memory');
  expect(names).toContain('config_schema');
  expect(names).toContain('datetime');
  expect(names).toContain('remind');
  expect(names).toContain('background');
  expect(names).toContain('todo');
  expect(names).toContain('host:plugins_list');
  expect(names).toContain('host:plugins_update');
  expect(names).toContain('tracker:get_issue');
});

test('datetime reports the current local date/time (and a named zone), read-only', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  // Default: host local zone. Returns timezone, epoch, UTC iso and the local clock.
  const out = await reg.exec('datetime', {}, {});
  expect(out).toContain('timezone: ');
  expect(out).toMatch(/epoch: \d+/);
  expect(out).toContain('iso-utc: ');
  expect(out).toContain('local: ');
  // A named zone is honored.
  const utc = await reg.exec('datetime', { zone: 'UTC' }, {});
  expect(utc).toContain('timezone: UTC ');
  const msk = await reg.exec('datetime', { zone: 'Europe/Moscow' }, {});
  expect(msk).toContain('timezone: Europe/Moscow ');
  // An invalid zone returns a friendly error instead of throwing.
  const bad = await reg.exec('datetime', { zone: 'bogus/zone' }, {});
  expect(bad).toContain('Invalid timezone');
});

test('remind parses a duration/clock and delegates to the host setReminder', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  // A duration is parsed and handed to the host service; we stub setReminder to
  // capture the (text, ms) without waiting for the timer.
  let called: { text: string; ms: number } | null = null;
  const ctx = { setReminder: (text: string, ms: number) => { called = { text, ms }; } } as any;
  const out = await reg.exec('remind', { text: 'blink', in: '3 minutes' }, ctx);
  expect(out).toContain('Reminder set');
  expect(called).toEqual({ text: 'blink', ms: 180000 });
  // A wall-clock time (`at`) also schedules; past time rolls to tomorrow.
  let atMs: number | null = null;
  const atOut = await reg.exec('remind', { text: 'stand up', at: '01:30' }, { setReminder: (_t: string, ms: number) => { atMs = ms; } } as any);
  expect(atOut).toContain('Reminder set');
  expect(typeof atMs).toBe('number');
  // An unparseable duration is rejected, not thrown.
  const bad = await reg.exec('remind', { text: 'x', in: 'three minutes' }, { setReminder: () => {} } as any);
  expect(bad).toContain('Unparseable duration');
  // Missing the host service degrades gracefully.
  const noSvc = await reg.exec('remind', { text: 'x', in: '1 minute' }, {} as any);
  expect(noSvc).toContain('Reminder unavailable');
  // text is required.
  const noText = await reg.exec('remind', { in: '1 minute' }, ctx);
  expect(noText).toContain('text is required');
});

// Yields a macrotask so a detached background run can finish its (immediate)
// work and deliver the result before the assertion runs.
const flushBg = () => new Promise<void>((r) => setTimeout(r, 0));

// ─── todo (plan) tool ──────────────────────────────────────────────────────────
// Session-only plan state is MODULE-level (like bgActive), so each test resets it
// through the `clear` action to avoid leaking into the next test. The plan is a
// scratchpad the assistant maintains: low-stakes, reversible, no write-confirm.

test('todo add creates a pending item, assigns an id and notifies', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  let notifies = 0;
  const ctx = { notify: () => { notifies++; } } as any;
  const out = await reg.exec('todo', { action: 'add', text: 'write the test' }, ctx);
  expect(out).toContain('t1 · write the test');
  expect(notifies).toBe(1);
  await reg.exec('todo', { action: 'clear' }, ctx);
});

test('todo add requires text', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const out = await reg.exec('todo', { action: 'add' }, {});
  expect(out).toContain('text is required');
});

test('todo add accepts a whole batch of items in one call', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  let notifies = 0;
  const ctx = { notify: () => { notifies++; } } as any;
  const out = await reg.exec('todo', { action: 'add', items: ['a', 'b', 'c'] }, ctx);
  // One call, one notify (not one per item), and the ids are returned so the model
  // can target them later.
  expect(out).toContain('Added 3');
  expect(out).toContain('t1 · a');
  expect(out).toContain('t2 · b');
  expect(out).toContain('t3 · c');
  expect(notifies).toBe(1);
  const list = await reg.exec('todo', { action: 'list' }, ctx);
  expect(list).toContain('☐ t1 · a');
  expect(list).toContain('☐ t3 · c');
  await reg.exec('todo', { action: 'clear' }, ctx);
});

test('todo set replaces the whole plan (full-replace) and keeps ids by text', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ctx = { notify: () => {} } as any;
  await reg.exec('todo', { action: 'set', todos: [{ text: 'a', status: 'in_progress' }, { text: 'b' }] }, ctx);
  let list = await reg.exec('todo', { action: 'list' }, ctx);
  expect(list).toContain('⊟ t1 · a');
  expect(list).toContain('☐ t2 · b');
  // Re-set: 'a' keeps t1 (now done), 'b' is dropped, new 'c' gets a fresh id.
  await reg.exec('todo', { action: 'set', todos: [{ text: 'a', status: 'done' }, { text: 'c' }] }, ctx);
  list = await reg.exec('todo', { action: 'list' }, ctx);
  expect(list).toContain('☑ t1 · a');
  expect(list).toContain('☐ t3 · c');
  expect(list).not.toContain('b');
  await reg.exec('todo', { action: 'clear' }, ctx);
});

test('todo set with an empty array clears the plan (done task leaves no stale plan)', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ctx = { notify: () => {} } as any;
  await reg.exec('todo', { action: 'set', todos: [{ text: 'a', status: 'done' }, { text: 'b', status: 'done' }] }, ctx);
  expect(await reg.exec('todo', { action: 'list' }, ctx)).toContain('☑ t1 · a');
  // Full-replace semantics allow "no remaining plan": an empty list empties the
  // plan (same as clear), so a finished task doesn't leave a stale ▾ plan.
  const out = await reg.exec('todo', { action: 'set', todos: [] }, ctx);
  expect(out).toContain('Plan cleared');
  expect(await reg.exec('todo', { action: 'list' }, ctx)).toContain('Plan is empty');
});

test('todo list reports the items in plan order, with ids', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ctx = { notify: () => {} } as any;
  await reg.exec('todo', { action: 'add', text: 'a' }, ctx);
  await reg.exec('todo', { action: 'add', text: 'b' }, ctx);
  await reg.exec('todo', { action: 'complete', id: 1 }, ctx);
  const list = await reg.exec('todo', { action: 'list' }, ctx);
  // The plan's own order, whatever the states: a done item stays where it was.
  expect(list).toBe('☑ t1 · a (done)\n☐ t2 · b (pending)');
  await reg.exec('todo', { action: 'clear' }, ctx);
});

test('todo complete/uncomplete toggles an item by id', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ctx = { notify: () => {} } as any;
  await reg.exec('todo', { action: 'add', text: 'a' }, ctx);
  const done = await reg.exec('todo', { action: 'complete', id: 1 }, ctx);
  expect(done).toContain('☑');
  const undone = await reg.exec('todo', { action: 'uncomplete', id: 1 }, ctx);
  expect(undone).toContain('☐');
  await reg.exec('todo', { action: 'clear' }, ctx);
});

test('todo start marks an item in-progress (several may be in-progress)', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ctx = { notify: () => {} } as any;
  await reg.exec('todo', { action: 'add', text: 'a' }, ctx);
  await reg.exec('todo', { action: 'add', text: 'b' }, ctx);
  const started = await reg.exec('todo', { action: 'start', id: 1 }, ctx);
  expect(started).toContain('⊟');
  expect(started).toContain('in progress');
  // Several in-progress items may coexist — starting id 2 must not reset id 1.
  await reg.exec('todo', { action: 'start', id: 2 }, ctx);
  const list = await reg.exec('todo', { action: 'list' }, ctx);
  expect(list).toContain('⊟ t1 · a');
  expect(list).toContain('⊟ t2 · b');
  await reg.exec('todo', { action: 'clear' }, ctx);
});

test('todo targets an item by text, not only by id', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ctx = { notify: () => {} } as any;
  await reg.exec('todo', { action: 'add', text: '73' }, ctx);
  await reg.exec('todo', { action: 'add', text: '42' }, ctx);
  // The model names the item by its text ("73") — start/complete by text.
  const started = await reg.exec('todo', { action: 'start', text: '73' }, ctx);
  expect(started).toContain('⊟ t1 · 73');
  const done = await reg.exec('todo', { action: 'complete', text: '73' }, ctx);
  expect(done).toContain('☑ t1 · 73');
  const other = await reg.exec('todo', { action: 'start', text: '42' }, ctx);
  expect(other).toContain('⊟ t2 · 42');
  // Unknown text → friendly error.
  const missing = await reg.exec('todo', { action: 'complete', text: '999' }, ctx);
  expect(missing).toContain('not found');
  await reg.exec('todo', { action: 'clear' }, ctx);
});

test('todo update edits an item text; remove deletes it', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ctx = { notify: () => {} } as any;
  await reg.exec('todo', { action: 'add', text: 'old' }, ctx);
  const upd = await reg.exec('todo', { action: 'update', id: 1, text: 'new' }, ctx);
  expect(upd).toContain('new');
  const rem = await reg.exec('todo', { action: 'remove', id: 1 }, ctx);
  expect(rem).toContain('removed');
  const list = await reg.exec('todo', { action: 'list' }, ctx);
  expect(list).toContain('Plan is empty');
  await reg.exec('todo', { action: 'clear' }, ctx);
});

test('todo errors on unknown id', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const out = await reg.exec('todo', { action: 'complete', id: 999 }, {});
  expect(out).toContain('not found');
});

test('todo clear empties the plan', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ctx = { notify: () => {} } as any;
  await reg.exec('todo', { action: 'add', text: 'a' }, ctx);
  await reg.exec('todo', { action: 'add', text: 'b' }, ctx);
  const out = await reg.exec('todo', { action: 'clear' }, ctx);
  expect(out).toContain('cleared');
  const list = await reg.exec('todo', { action: 'list' }, ctx);
  expect(list).toContain('Plan is empty');
});

test('background requires a task', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const out = await reg.exec('background', {}, {});
  expect(out).toContain('task is required');
});

test('background is unavailable without an LLM service', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const out = await reg.exec('background', { task: 'do it' }, {});
  expect(out).toContain('unavailable');
});

test('background offloads a detached task and reports the result when done', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const logs: string[] = [];
  const msgs: string[] = [];
  const chatPosts: string[] = [];
  let notifies = 0;
  let capturedOpts: Record<string, unknown> | null = null;
  let capturedMsgs: unknown[] | null = null;
  const ctx = {
    chatLLM: async (msgs: unknown[], opts: Record<string, unknown>) => { capturedMsgs = msgs; capturedOpts = opts; return { content: 'build ok' }; },
    pushLog: (e: string) => logs.push(e),
    showMessage: (m: string) => msgs.push(m),
    notify: () => { notifies++; },
    postToChat: (t: string) => chatPosts.push(t),
    pluginAiTools: [],
    // The chat toolCtx carries the host config; the nested run derives its LLM
    // creds from here + the env var (the same way the chat's send() does).
    config: { ai: { baseUrl: 'http://llm.local', model: 'test-model', tokenEnv: 'FLOW_ASSIST_BG_TOKEN' } },
  } as any;
  process.env.FLOW_ASSIST_BG_TOKEN = 'secret';
  const out = await reg.exec('background', { task: 'run the build', label: 'build' }, ctx);
  expect(out).toContain('Background task started');
  expect(out).toContain('build');
  await flushBg(); // let the detached run finish + deliver
  expect(logs.join('\n')).toContain('[bg] build: build ok');
  expect(msgs.join('\n')).toContain('build');
  // After the run completes, the in-flight count returns to zero.
  expect(bgActiveCount()).toBe(0);
  // notify() fires TWICE: once when the task is ARMED (the chat's live "N in
  // background" indicator bumps up as the task is scheduled) and once in `finally`
  // as it completes (bumps back down).
  expect(notifies).toBe(2);
  // The result is also injected back into the chat (the assistant's postToChat).
  // No "[background]" prefix — the chat's Background role label carries the marker.
  expect(chatPosts.join('\n')).toContain('build finished');
  expect(chatPosts.join('\n')).toContain('build ok');
  // The nested run is READ-ONLY: writes are declined so an autonomous task can
  // never mutate host state silently (no human to answer a y/n prompt).
  expect(typeof capturedOpts?.confirmWrite).toBe('function');
  expect((capturedOpts?.confirmWrite as () => boolean)()).toBe(false);
  // The nested run got the LLM creds — without them agentChat throws "LLM_TOKEN is
  // not set" and the task fails even though the chat itself authenticates.
  expect(capturedOpts?.baseUrl).toBe('http://llm.local');
  expect(capturedOpts?.model).toBe('test-model');
  expect(capturedOpts?.token).toBe('secret');
  // The nested run's system prompt GROUNDS time: it must tell the fresh agent to call
  // `datetime` for a now-sensitive question (never answer from stale memory) — that is
  // what makes the result the ACTUAL time at fire-time, not a guess.
  const sysPrompt = String((capturedMsgs?.[0] as { role?: string; content?: string } | undefined)?.content ?? '');
  expect(sysPrompt).toContain('`datetime` tool');
  expect(sysPrompt).toContain('stale');
  delete process.env.FLOW_ASSIST_BG_TOKEN;
});

test('background honors a start delay (not scheduled to run yet)', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const logs: string[] = [];
  const ctx = {
    chatLLM: async () => ({ content: 'late' }),
    pushLog: (e: string) => logs.push(e),
    showMessage: () => {},
    notify: () => {},
    pluginAiTools: [],
  } as any;
  const out = await reg.exec('background', { task: 'x', in: '3 minutes' }, ctx);
  expect(out).toContain('in 180s');
  // Deferred: the 180s timer has not fired, so no result is delivered yet.
  expect(logs.length).toBe(0);
  // Even though the task hasn't fired, it is IN FLIGHT (armed) — the chat's «N in
  // background» indicator must reflect a scheduled-but-not-yet-starting task.
  expect(bgActiveCount()).toBe(1);
});

test('background bursts are QUEUED, not dropped (concurrency cap bounds parallel runs)', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const chatPosts: string[] = [];
  // Simulate real work so the runs overlap: each nested agent takes ~20ms. This
  // makes the MAX-concurrency cap actually engage when 5 tasks fire at once.
  let concurrent = 0, peak = 0;
  const ctx = {
    chatLLM: async () => {
      concurrent++; peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return { content: 'ok' };
    },
    pushLog: () => {}, showMessage: () => {}, notify: () => {},
    postToChat: (t: string) => chatPosts.push(t),
    pluginAiTools: [],
    config: { ai: { baseUrl: 'http://llm.local', model: 'm', tokenEnv: 'FLOW_ASSIST_BG_TOKEN' } },
  } as any;
  process.env.FLOW_ASSIST_BG_TOKEN = 'secret';
  const outs: string[] = [];
  for (let i = 0; i < 5; i++) outs.push(await reg.exec('background', { task: `t${i}`, label: `t${i}`, in: '0s' }, ctx));
  // No task is rejected — every one is accepted (they may wait for a slot).
  expect(outs.join('\n')).not.toContain('Too many');
  expect(outs.join('\n')).toMatch(/Background task started/);
  // Wait for all five to run (3 concurrent + 2 queued → ~3 batches × 20ms).
  await new Promise((r) => setTimeout(r, 250));
  // EVERY task delivered its result to the chat — none was silently dropped.
  expect(chatPosts).toHaveLength(5);
  expect(chatPosts.join('\n')).toMatch(/t4 finished/);
  // The cap still bounds CONCURRENT runs (the safety valve holds).
  expect(peak).toBeLessThanOrEqual(3);
  delete process.env.FLOW_ASSIST_BG_TOKEN;
});

test('ai.disabledTools withholds a whole group', () => {
  const make = makeFactory({});
  const plugins = [make('gitlab', { tools: [{ id: 'gitlab', tools: [{ type: 'function', function: { name: 'gitlab:mr', description: '', parameters: {} } }], exec: async () => '' }] })];
  const reg = assembleToolRegistry({ plugins, config: { ai: { disabledTools: ['gitlab'] } }, repo: { list: async () => [] } as any });
  expect(reg.tools.map(t => t.function.name)).not.toContain('gitlab:mr');
});

test('the model gets no `config` and no `log` tool — a read-only `config_schema` and a `config_set` bound by the marks', () => {
  // Config is the model's own leash (disabledTools, baseUrl, tokenEnv, plugin
  // roots) and the assistant reads other people's text, so even a y/n-confirmed
  // write is one prompt injection plus one tired keypress away. The person owns
  // the values; the model sees the structure and proposes the command — and changes
  // itself only a key its schema node marks, which is a write only when it will happen.
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const names = reg.tools.map((t) => t.function.name);
  expect(names).toContain('config_schema');
  expect(names).toContain('config_set');
  expect(names).not.toContain('config');
  expect(names).not.toContain('log');
  expect(reg.tools.find((t) => t.function.name === 'config_schema')?.write).toBeUndefined();
  const write = reg.groups.flatMap((g) => g.tools).find((t) => t.function.name === 'config_set')?.write as (a: Record<string, unknown>) => boolean;
  expect(write({ key: 'ui.verbs', value: ['Thinking'], scope: 'session' })).toBe(true);
  expect(write({ key: 'ai.disabledTools', value: [], scope: 'session' })).toBe(false);
  expect(write({ key: 'shell.roots', value: ['/'], scope: 'saved' })).toBe(false);
  expect(write({ key: 'ui.verbs', value: 'not a list', scope: 'session' })).toBe(false);
});

test('config_set refuses by throwing — a refusal returned would read as a change made', async () => {
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  await expect(reg.exec('config_set', { key: 'ai.baseUrl', value: 'https://elsewhere.example', scope: 'saved' }, {})).rejects.toThrow(/ai\.baseUrl is not a key the model may change.*config set ai\.baseUrl https:\/\/elsewhere\.example/);
  // A marked key runs only on the loop's own word that the person said yes to this call:
  // with nobody to confirm it (the one-shot prompt), or a chat's hooks but no yes, it is
  // refused.
  await expect(reg.exec('config_set', { key: 'ui.verbs', value: ['x'], scope: 'session' }, {})).rejects.toThrow(/nobody here to confirm it/);
  await expect(reg.exec('config_set', { key: 'ui.verbs', value: ['x'], scope: 'session' }, { askUser: async () => ({ answers: [], cancelled: false }) } as never)).rejects.toThrow(/nobody here to confirm it/);
  const { resetSessionConfig } = await import('../../config/load');
  try {
    expect(String(await reg.exec('config_set', { key: 'ui.verbs', value: ['x'], scope: 'session' }, { confirmedByPerson: true }))).toMatch(/ui\.verbs is \["x"\] for this session/);
  } finally {
    resetSessionConfig();
  }
});

test('a plugin tool\'s maxResultChars never reaches the wire-facing tool def', () => {
  // The wire-facing `reg.tools` (LLM-facing, `write`/`run` tree-shaken out by
  // `stripTool`) must not carry the per-tool result cap either — it is host-side
  // bookkeeping (src/assistant/agent.ts), not something a provider understands.
  const make = makeFactory({});
  const plugins = [
    make('t', {
      aiTools: [{ type: 'function', function: { name: 't:wide', description: 'wide', parameters: { type: 'object', properties: {} } }, maxResultChars: 100_000, run: async () => 'x' }],
    }),
  ];
  const reg = assembleToolRegistry({ plugins, config: {}, repo: { list: async () => [] } as any });
  const wireDef = reg.tools.find((t) => t.function.name === 't:wide');
  expect(wireDef).toBeDefined();
  expect((wireDef as Record<string, unknown>).maxResultChars).toBeUndefined();
});

test('background\'s description promises only what the default keeps: a result in the chat, read on the next turn', () => {
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const desc = reg.tools.find((t) => t.function.name === 'background')!.function.description;
  // With ai.backgroundFollowUp off (the default) no turn starts for a result, so
  // nothing may say the assistant reacts to one by itself.
  // Nor may an example ask for a report the host does not make ("tell me when it is done").
  for (const promise of [/analy[sz]es it/i, /when idle/i, /opens it/i, /reports? back/i, /tell me when/i, /скажи,? когда/i, /отчитайся/i]) expect(desc).not.toMatch(promise);
  expect(desc).toContain('next turn');
  expect(desc).toContain('ai.backgroundFollowUp');
  expect(desc).toMatch(/do not promise/i);
  expect(desc).toMatch(/open(s)? with what came back/i);
});

test('config_schema says what ai.backgroundFollowUp does, from the config side', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-cfgschema-bg-'));
  const local = join(dir, 'config.local.json');
  writeFileSync(local, '{}');
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const out = await reg.exec('config_schema', { key: 'ai' }, { configLocalPath: local });
  expect(out).toMatch(/- ai\.backgroundFollowUp: true\|false — unset \(default: false — a background task's result lands in the chat .* reaches the model on its next turn, which starts when the person writes again/);
  expect(out).toMatch(/config set ai\.backgroundFollowUp true/);
});

test('config_schema says what ai.autoCompact does, and the model may not set it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-cfgschema-ac-'));
  const local = join(dir, 'config.local.json');
  writeFileSync(local, '{}');
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const out = String(await reg.exec('config_schema', { key: 'ai.autoCompact' }, { configLocalPath: local }));
  expect(out).toMatch(/- ai\.autoCompact\.enabled: true\|false — unset \(default: enabled: true, threshold: 0\.8 — before a request that would pass threshold of ai\.contextWindow/);
  expect(out).toMatch(/- ai\.autoCompact\.threshold: .*unset/);
  expect(out).toContain('config set ai.autoCompact.enabled false');
  expect(out).not.toContain('· model may set');
  await expect(reg.exec('config_set', { key: 'ai.autoCompact.enabled', value: false, scope: 'session' }, { configLocalPath: local })).rejects.toThrow();
});

test('config_schema shows structure, defaults and set/unset — never a value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-cfgschema-'));
  const local = join(dir, 'config.local.json');
  writeFileSync(local, JSON.stringify({ ai: { model: 'secret-model-name', baseUrl: 'https://llm.internal.example' }, user: { name: 'Ada Lovelace' } }));
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const out = await reg.exec('config_schema', {}, { configLocalPath: local });
  expect(out).toMatch(/- ai\.model: string — set/);
  expect(out).toMatch(/- ai\.stream: true\|false — unset/);
  // An unset ai.toolResultMaxChars carries its active default, so the model can
  // explain the cap accurately instead of guessing.
  expect(out).toMatch(/- ai\.toolResultMaxChars: number — unset \(default: 40000 — a tool result longer than this is cut/);
  expect(out).toMatch(/- user\.name: string — set/);
  for (const secret of ['secret-model-name', 'llm.internal.example', 'Ada Lovelace']) expect(out).not.toContain(secret);
  // The model once claimed "cache is off by default": an unset key carries its ACTIVE default.
  expect(out).toMatch(/- cache\.enabled: true\|false — unset \(default: enabled: true/);
  // It can help, but only by handing the person a command.
  expect(out).toMatch(/config set <key> <value>/);
  // A subtree narrows the listing.
  const ai = await reg.exec('config_schema', { key: 'ai' }, { configLocalPath: local });
  expect(ai).toMatch(/- ai\.model/);
  expect(ai).not.toMatch(/- cache/);
  // A leaf takes the note of its nearest parent: images are on, and it says how to stop them.
  expect(ai).toMatch(/- ai\.images\.enabled: true\|false — unset \(default: enabled: true — .*config set ai\.images\.enabled false/);
  expect(ai).toMatch(/- ai\.images\.maxBytes: .* — unset \(default: enabled: true/);
  expect(await reg.exec('config_schema', { key: 'nope.nothing' }, {})).toMatch(/unknown key/);
});

test('config_schema reports EFFECTIVE key bindings and a plugin\'s own flags', async () => {
  const make = makeFactory({});
  const keycapsSchema = z.object({ enabled: z.boolean().optional(), colors: z.record(z.string(), z.unknown()).optional() }).optional();
  const plugins = [
    make('assistant', { keys: { chat: 'F' } }),
    make('keycaps', { configSchema: keycapsSchema, keys: {} }),
  ];
  const reg = assembleToolRegistry({ plugins, config: {}, repo: { list: async () => [] } as any });
  const out = await reg.exec('config_schema', {}, {});
  // Bindings are not personal data and are exactly what "how do I remap X" needs:
  // host defaults + plugin keys, not the (empty) override map.
  expect(out).toMatch(/chat: F/);
  expect(out).toMatch(/quit: \(unbound\)/); // the :quit command, not a key — and said, not blank
  expect(out).toMatch(/open: enter[,} ]/); // shown as a person writes it, not as "return"
  // The host sees `plugins` as an opaque record; the plugin's configSchema fills it in.
  expect(out).toMatch(/- plugins\.keycaps\.enabled: true\|false — unset/);
});

test('host:plugins_list reports the always-loaded built-ins, not just the (empty) registry', async () => {
  const make = makeFactory({});
  // The 4 built-ins are loaded but the registry list omits them, so without this the
  // LLM would conclude "no plugins" (as it once did in the chat: "there is no keycaps plugin").
  const plugins = ['core', 'assistant', 'keycaps', 'log'].map(name => make(name, { keys: {} }));
  const reg = assembleToolRegistry({ plugins, config: {}, repo: { list: async () => [] } as any });
  const out = JSON.parse(await reg.exec('host:plugins_list', {}, {})) as { name: string; builtin?: boolean }[];
  const names = out.map(e => e.name);
  expect(names).toEqual(['core', 'assistant', 'keycaps', 'log']);
  expect(out.every(e => e.builtin === true)).toBe(true);
  // A registry plugin is still listed alongside the built-ins (deduped by name).
  const reg2 = assembleToolRegistry({ plugins, config: {}, repo: { list: async () => ([{ name: 'tracker', version: '1.0', description: '', active: true, missingDeps: [], source: 'registry' }]) } as any });
  const out2 = JSON.parse(await reg2.exec('host:plugins_list', {}, {})) as { name: string; builtin?: boolean }[];
  expect(out2.map(e => e.name)).toContain('tracker');
  expect(out2.filter(e => e.name === 'tracker')[0].builtin).toBeUndefined();
});

test('plugin tool exec receives the HOST-issued pluginToken, ignoring a caller-supplied name', async () => {
  const make = makeFactory({});
  let token: symbol | undefined;
  const plugins = [make('keycaps', {
    tools: [{
      id: 'keycaps', alwaysOn: false,
      tools: [{ type: 'function', function: { name: 'keycaps:who', description: '', parameters: {} } }],
      exec: async (_n, _a, ctx) => { token = ctx.pluginToken; return 'ok'; },
    }],
  })];
  const reg = assembleToolRegistry({ plugins, config: {}, repo: { list: async () => [] } as any });
  // The caller passes a RAW NAME — the exec closure ignores it and injects the
  // host-issued token for the real owner, so a plugin can never impersonate one.
  await reg.exec('keycaps:who', {}, { pluginName: 'tracker' } as any);
  expect(token).toBe(identityToken('keycaps'));
});

test('ai-tool run fuses the OWNING plugin services + preserves caller ctx + host token', async () => {
  const make = makeFactory({});
  // A nav ai-tool that reports exactly the ctx it received: the plugin's own
  // services (openIssue stub) must be present even when the caller passes `{}`,
  // and the caller's real host service (openBrowser) must WIN over any stub.
  const seen: any = {};
  const maker = make('tracker', {
    services: { openIssue: (code: string) => `STUB openIssue ${code}`, openBrowser: (u: string) => `STUB openBrowser ${u}` },
    aiTools: [{
      type: 'function',
      function: { name: 'open_issue', description: '', parameters: {} },
      run: (_args: any, ctx: any) => { seen.ctx = ctx; return 'ok'; },
    }],
  });
  // reg groups collect the aiTools into a synthetic `tracker:aiTools` group; the
  // caller passes ONLY a real host openBrowser (no plugin services, no token).
  const reg = assembleToolRegistry({ plugins: [maker], config: {}, repo: { list: async () => [] } as any });
  const hostOpenBrowser = (u: string) => `REAL openBrowser ${u}`;
  // Offered under the name the plugin gave it — no prefix added by the loader.
  expect(reg.tools.map((t) => t.function.name)).toContain('open_issue');
  await reg.exec('open_issue', {}, { openBrowser: hostOpenBrowser });
  // The plugin's own services are fused into the run ctx (openIssue stub present).
  expect(typeof seen.ctx.openIssue).toBe('function');
  expect(seen.ctx.openIssue('ABC-1')).toContain('STUB openIssue ABC-1');
  // The CALLER's service wins on a shared key (host openBrowser beats the stub).
  expect(seen.ctx.openBrowser).toBe(hostOpenBrowser);
  expect(seen.ctx.openBrowser('x')).toContain('REAL openBrowser x');
  // The host-issued plugin token is injected (identity), not a spoofable name.
  expect(seen.ctx.pluginToken).toBe(identityToken('tracker'));
});

// A workspace root of the test's own, and a conversation in a project of its own.
const memSetup = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-mem-ws-')));
  const config = { workspace: { dir: root } };
  const reg = assembleToolRegistry({ plugins: [], config, repo: { list: async () => [], remove: async () => ({ ok: true }) } as any });
  const inProject = (project: string | null) => ({ workspaceProject: () => project });
  return { root, config, reg, inProject };
};

test('the memory tool keeps each fact as a file in the project\'s workspace, or the global one; a fact of project A is never listed in project B', async () => {
  const { root, reg, inProject } = memSetup();
  const a = inProject('/p/a');
  const b = inProject('/p/b');
  const stored = String(await reg.exec('memory', { action: 'add', text: 'The build needs ZANZIBAR set.', name: 'Build variable', type: 'convention' }, a));
  expect(stored).toContain('build-variable');
  expect(readFacts(workspaceDir(root, '/p/a')).map((f) => f.text)).toEqual(['The build needs ZANZIBAR set.']);
  expect(String(await reg.exec('memory', { action: 'list' }, a))).toContain('ZANZIBAR');
  expect(String(await reg.exec('memory', { action: 'list' }, b))).not.toContain('ZANZIBAR');

  // Global: every project sees it. `host` — the older word — reads as global.
  await reg.exec('memory', { action: 'add', text: 'Answers in Russian.', scope: 'global' }, a);
  await reg.exec('memory', { action: 'add', text: 'Prefers short answers.', scope: 'host' }, a);
  expect(readFacts(workspaceDir(root, null)).map((f) => f.text).sort()).toEqual(['Answers in Russian.', 'Prefers short answers.']);
  const inB = String(await reg.exec('memory', { action: 'list' }, b));
  expect(inB).toContain('Answers in Russian.');
  expect(inB).toContain('(global');
  expect(String(await reg.exec('memory', { action: 'list', scope: 'project' }, b))).toBe('No memories stored yet.');

  // Any other scope is refused, naming the two there are.
  expect(String(await reg.exec('memory', { action: 'add', text: 'x', scope: 'plugin' }, a))).toContain('"project" or "global"');

  // update edits in place, and moves a fact to the scope it names; forget removes it.
  const id = readFacts(workspaceDir(root, '/p/a'))[0]!.id;
  expect(String(await reg.exec('memory', { action: 'update', id, text: 'The build needs ZANZIBAR=1 set.' }, a))).toContain('updated');
  expect(readFacts(workspaceDir(root, '/p/a'))[0]!.text).toBe('The build needs ZANZIBAR=1 set.');
  await reg.exec('memory', { action: 'update', id, scope: 'global' }, a);
  expect(readFacts(workspaceDir(root, '/p/a'))).toEqual([]);
  expect(readFacts(workspaceDir(root, null)).some((f) => f.id === id)).toBe(true);
  expect(String(await reg.exec('memory', { action: 'forget', id }, b))).toContain('deleted');
  expect(readFacts(workspaceDir(root, null)).some((f) => f.id === id)).toBe(false);
  // The index follows every write.
  expect(fs.readFileSync(path.join(workspaceDir(root, null), 'memory', 'MEMORY.md'), 'utf8')).not.toContain(id);
});

test('without a chat the project is where the call\'s shell is', async () => {
  const { root, reg } = memSetup();
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-mem-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  await reg.exec('memory', { action: 'add', text: 'A fact of this repo.' }, { shell: { cwd: () => repo } });
  expect(readFacts(workspaceDir(root, repo)).map((f) => f.text)).toEqual(['A fact of this repo.']);
});

test('host:plugins_remove purges the facts an older host kept for the removed plugin', async () => {
  const { root, reg } = memSetup();
  const g = workspaceDir(root, null);
  addFact(g, { text: 'keycap note', plugin: 'keycaps' });
  addFact(g, { text: 'host note' });
  await reg.exec('host:plugins_remove', { name: 'keycaps' }, {});
  expect(readFacts(g).map((f) => f.text)).toEqual(['host note']);
});

test('ask_user hands validated questions to the chat and reads the answer back', async () => {
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  expect(reg.tools.map((t) => t.function.name)).toContain('ask_user');
  const args = { questions: [{ question: 'Rebase or merge?', options: [{ label: 'rebase' }, { label: 'merge' }] }] };

  const asked: unknown[] = [];
  const askUser = async (questions: any[]) => {
    asked.push(questions);
    return { cancelled: false, answers: [{ question: questions[0].question, labels: ['rebase'] }] } as any;
  };
  expect(await reg.exec('ask_user', args, { askUser })).toBe('The user answered:\n- Rebase or merge? → rebase');
  expect(asked).toHaveLength(1);

  // Malformed questions never reach the person.
  const bad = await reg.exec('ask_user', { questions: [{ question: 'q', options: [{ label: 'only' }] }] }, { askUser });
  expect(bad).toMatch(/2–4 options/);
  expect(asked).toHaveLength(1);

  // A dismissal is reported as one.
  const dismissed = await reg.exec('ask_user', args, { askUser: async () => ({ cancelled: true, answers: [] }) as any });
  expect(dismissed).toMatch(/dismissed the question/);

  // No chat to ask in (a one-shot prompt, a background task): say so, do not hang.
  expect(await reg.exec('ask_user', args, {})).toMatch(/nobody to ask/i);
});

test('a background task cannot put a question to the person', async () => {
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  let nested: Record<string, unknown> | undefined;
  const chatLLM = async (_messages: unknown[], opts: Record<string, unknown>) => { nested = opts.toolCtx as Record<string, unknown>; return { content: 'done' }; };
  await reg.exec('background', { task: 'summarize the repo' }, { chatLLM, askUser: async () => ({ cancelled: false, answers: [] }), postToChat: () => {} } as any);
  for (let i = 0; i < 20 && !nested; i++) await new Promise((r) => setTimeout(r, 5));
  expect(nested).toBeDefined();
  expect(nested!.askUser).toBeUndefined();
  // …and with no hook the tool says so instead of hanging.
  const args = { questions: [{ question: 'q?', options: [{ label: 'a' }, { label: 'b' }] }] };
  expect(await reg.exec('ask_user', args, nested as any)).toMatch(/nobody to ask/i);
});

test('a tool name is claimed once: the first plugin keeps the bare word, the second is offered qualified', async () => {
  const make = makeFactory({});
  const group = (id: string, answer: string) => ({
    id,
    tools: [
      { type: 'function', function: { name: 'search', description: '', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: `${id}_only`, description: '', parameters: { type: 'object', properties: {} } } },
    ],
    exec: async () => answer,
  });
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (m: unknown) => { warned.push(String(m)); };
  try {
    const reg = assembleToolRegistry({
      plugins: [make('repo', { tools: [group('repo', 'from repo')] }), make('notes', { tools: [group('notes', 'from notes')] })],
      config: {},
      repo: { list: async () => [] } as any,
    });
    const names = reg.groups.flatMap((g) => g.tools.map((t) => t.function.name));
    // The bare word once; the second claimant under its plugin's name — nothing is lost.
    expect(names.filter((n) => n === 'search')).toHaveLength(1);
    expect(names).toContain('notes:search');
    expect(names).toContain('notes_only');
    // It is said, with both owners and the way out.
    expect(warned.join('\n')).toMatch(/"search" is declared by both repo and notes/);
    expect(warned.join('\n')).toContain('notes:search');
    expect(String(await reg.exec('search', {}, {}))).toBe('from repo');
    // The qualified one reaches ITS group, under the name that group knows.
    expect(String(await reg.exec('notes:search', {}, {}))).toBe('from notes');
  } finally {
    console.warn = realWarn;
  }
});

test('the memory tool says how an entry is written, and refuses a near-copy — in either scope — a paragraph, and a full list', async () => {
  const { root, reg, inProject } = memSetup();
  // The rules ride in the description of every request; a drift out of the prompt is
  // what this holds. The first sentence is the tools-on-demand index and stays put.
  const description = reg.tools.find((t) => t.function.name === 'memory')!.function.description!;
  expect(description.startsWith('Persistent cross-session memory.')).toBe(true);
  for (const rule of ['ONE durable fact per entry', 'stands without the conversation', 'never a secret or a token', 'UPDATE the entry that already says it', '300 characters', '100 entries', '/memory', 'workspace_read']) {
    expect(description).toContain(rule);
  }

  const ctx = inProject('/p/a');
  const facts = () => readFacts(workspaceDir(root, '/p/a'));
  const first = String(await reg.exec('memory', { action: 'add', text: 'This repo prefers rebase over merge.' }, ctx));
  expect(first).toContain('Memory stored');
  const id = facts()[0]!.id;
  // The same fact in other spacing and case does not become a second entry — which is
  // how one file came to hold 32 copies of this very sentence — nor does it in the
  // other scope.
  for (const scope of ['project', 'global']) {
    const again = String(await reg.exec('memory', { action: 'add', text: 'this repo prefers  rebase over merge', scope }, ctx));
    expect(again).toContain(id);
    expect(again).toContain('update');
  }
  expect(facts()).toHaveLength(1);
  expect(readFacts(workspaceDir(root, null))).toHaveLength(0);
  // A paragraph is refused with its length, and nothing is stored.
  const long = String(await reg.exec('memory', { action: 'add', text: 'y'.repeat(400) }, ctx));
  expect(long).toContain('400');
  expect(facts()).toHaveLength(1);
  // Updating the entry that already says it is the way through, and still works.
  const updated = String(await reg.exec('memory', { action: 'update', id, text: 'This repo rebases; it never merges.' }, ctx));
  expect(updated).toContain('updated');
  expect(facts()[0]!.text).toBe('This repo rebases; it never merges.');
  // The cap is per scope: a full project list refuses, the global one still takes.
  for (let i = facts().length; i < 100; i++) addFact(workspaceDir(root, '/p/a'), { text: `fact number ${i}` });
  expect(String(await reg.exec('memory', { action: 'add', text: 'one too many' }, ctx))).toContain('the memory is full');
  expect(String(await reg.exec('memory', { action: 'add', text: 'one too many', scope: 'global' }, ctx))).toContain('Memory stored');
});

test('a background run carries the project\'s instructions for its own shell directory, and cd there answers from its own reading', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-bg-instr-')));
  fs.mkdirSync(path.join(root, 'proj'));
  fs.writeFileSync(path.join(root, 'proj', 'AGENTS.md'), 'BG RULE');
  const config = { shell: { roots: [root] } };
  const reg = assembleToolRegistry({ plugins: [], config, repo: { list: async () => [] } as any });
  let opts: Record<string, unknown> | undefined;
  const chatLLM = async (_m: unknown[], o: Record<string, unknown>) => { opts = o; return { content: 'done' }; };
  // The chat's own reading must not leak into the background run's answers.
  const chats = () => ({ dir: '/chat', root: '/chat', files: [{ path: '/chat/AGENTS.md', text: 'x', cut: 0 }] });
  await reg.exec('background', { task: 'look at proj' }, { chatLLM, config, projectInstructions: chats, postToChat: () => {} } as any);
  for (let i = 0; i < 20 && !opts; i++) await new Promise((r) => setTimeout(r, 5));
  const nested = opts!.toolCtx as Record<string, any>;
  expect(nested.projectInstructions).toBeUndefined();
  const system = opts!.systemPrompt as () => string;
  expect(system()).not.toContain('## Project instructions');
  const answer = await reg.exec('cd', { path: 'proj' }, nested as any);
  expect(answer).toContain(path.join(root, 'proj', 'AGENTS.md'));
  expect(system()).toContain('## Project instructions');
  expect(system()).toContain('BG RULE');
});

// The model is told what it may change, and why, beside the key — and what waits for a
// restart — so it knows what to do itself and what to hand back as a command.
test('config_schema prints the marks beside a key, with the reason', async () => {
  const { modelMaySet, modelMaySave } = await import('../../config/schema');
  const make = makeFactory({});
  const plugins = [make('notes', { configSchema: z.object({
    compact: z.boolean().register(modelMaySet, { reason: 'a display flag' }).optional(),
    wide: z.boolean().register(modelMaySet, { reason: 'the width' }).register(modelMaySave, { reason: 'the width' }).optional(),
    file: z.string().optional(),
  }).optional() })];
  const reg = assembleToolRegistry({ plugins, config: {}, repo: { list: async () => [] } as any });
  const out = String(await reg.exec('config_schema', {}, { configLocalPath: join(mkdtempSync(join(tmpdir(), 'fa-marks-')), 'none.json') }));
  const row = (key: string) => out.split('\n').find((r) => r.startsWith(`- ${key}:`)) ?? '';
  expect(row('ui.verbs')).toMatch(/ · model may set · may save — the words on the status line/);
  expect(row('ui.mouse')).toMatch(/ · model may set · may save — .* · takes effect on restart/);
  expect(row('plugins.notes.compact')).toMatch(/ · model may set — a display flag/);
  expect(row('plugins.notes.compact')).not.toMatch(/may save/);
  expect(row('plugins.notes.wide')).toMatch(/ · model may set · may save — the width/);
  expect(row('plugins.notes.file')).not.toMatch(/model may/);
  expect(row('ai.model')).not.toMatch(/model may/);
  expect(row('keys')).toMatch(/takes effect on restart/);
});

test('ai.maxRounds and ai.maxTurnTokens take 0 for none, and the notes say which limit ends a turn', async () => {
  expect(hostConfigSchema.safeParse({ ai: { maxRounds: 0, maxTurnTokens: 0 } }).success).toBe(true);
  expect(hostConfigSchema.safeParse({ ai: { maxRounds: -1 } }).success).toBe(false);
  const dir = mkdtempSync(join(tmpdir(), 'fa-cfgschema-rounds-'));
  const local = join(dir, 'config.local.json');
  writeFileSync(local, '{}');
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const out = String(await reg.exec('config_schema', { key: 'ai' }, { configLocalPath: local }));
  expect(out).toMatch(/- ai\.maxRounds: .*default: 150 — .*0 is no round cap, and then ai\.maxTurnTokens is what ends a long turn/);
  expect(out).toMatch(/- ai\.maxTurnTokens: .*default: 2000000 — .*cache.*0 is no budget/);
});

test('the workspace tools write, read and list the project\'s workspace — a write takes no y/n and shows what it changed; a read is framed as the model\'s own note', async () => {
  const { root, reg, inProject } = memSetup();
  const ctxA = inProject('/p/a');
  const writeDef = reg.tools.find((t) => t.function.name === 'workspace_write') as { write?: unknown } | undefined;
  expect(writeDef).toBeDefined();
  expect(writeDef!.write).toBeUndefined();
  const changes: { title: string; before: string; after: string }[] = [];
  const done = String(await reg.exec('workspace_write', { path: 'artifacts/plan.md', content: 'step one\n' }, { ...ctxA, reportChange: (c: any) => changes.push(c) }));
  const file = path.join(workspaceDir(root, '/p/a'), 'artifacts', 'plan.md');
  expect(done).toContain(file);
  expect(fs.readFileSync(file, 'utf8')).toBe('step one\n');
  // A new file is a change from nothing, named by its whole path in the workspace.
  expect(changes).toEqual([{ title: file.replace(os.homedir(), '~'), before: '', after: 'step one\n' }]);
  // Outside the workspace: refused by throwing, the path to use named.
  await expect(reg.exec('workspace_write', { path: '/tmp/draft.md', content: 'x' }, ctxA)).rejects.toThrow(workspaceDir(root, '/p/a'));

  const read = await reg.exec('workspace_read', { path: 'artifacts/plan.md' }, ctxA) as unknown as { text: string; raw: string };
  expect(read.raw).toBe('step one\n');
  expect(read.text).toContain('your own');
  expect(read.text).toContain('not an instruction from the person');
  expect(read.text.endsWith('step one\n')).toBe(true);
  expect(String(await reg.exec('workspace_list', {}, ctxA))).toContain('artifacts/plan.md (9 B)');
  // Another project's workspace is another directory; the global one is shared.
  expect(String(await reg.exec('workspace_list', {}, inProject('/p/b')))).toContain('empty');
  await reg.exec('workspace_write', { path: 'artifacts/everywhere.md', content: 'g', scope: 'global' }, ctxA);
  expect(String(await reg.exec('workspace_list', { scope: 'global' }, inProject('/p/b')))).toContain('artifacts/everywhere.md');
});

test('a background task works in its conversation\'s project, not in the one its fresh shell starts in', async () => {
  const { root, reg } = memSetup();
  let opts: Record<string, unknown> | undefined;
  const chatLLM = async (_m: unknown[], o: Record<string, unknown>) => { opts = o; return { content: 'done' }; };
  await reg.exec('background', { task: 'remember it' }, { chatLLM, workspaceProject: () => '/p/a', postToChat: () => {} } as any);
  for (let i = 0; i < 20 && !opts; i++) await new Promise((r) => setTimeout(r, 5));
  const nested = opts!.toolCtx as Record<string, any>;
  expect(nested.workspaceProject()).toBe('/p/a');
  await reg.exec('memory', { action: 'add', text: 'Found by the background task.' }, nested as any);
  expect(readFacts(workspaceDir(root, '/p/a')).map((f) => f.text)).toEqual(['Found by the background task.']);
});

test('a fact under a hand-made file name is forgotten too, and a name that leads out is never one', async () => {
  const { root, reg, inProject } = memSetup();
  const ws = workspaceDir(root, '/p/a');
  addFact(ws, { text: 'kept by the tool' });
  // A file the person made by hand, under a name that is not a slug.
  fs.writeFileSync(path.join(ws, 'memory', 'My_Note.md'), '---\nname: mine\ndescription: d\ntype: fact\n---\nA hand-made note.\n');
  const listed = String(await reg.exec('memory', { action: 'list' }, inProject('/p/a')));
  expect(listed).toContain('A hand-made note.');
  expect(String(await reg.exec('memory', { action: 'forget', id: 'My_Note' }, inProject('/p/a')))).toContain('deleted');
  expect(fs.existsSync(path.join(ws, 'memory', 'My_Note.md'))).toBe(false);
  expect(String(await reg.exec('memory', { action: 'forget', id: '../../x' }, inProject('/p/a')))).toContain('not found');
});

test('moving a fact to another scope is held to that scope\'s cap and to the duplicate check — the fact itself left out of it', async () => {
  const { root, reg, inProject } = memSetup();
  const ctx = inProject('/p/a');
  const a = workspaceDir(root, '/p/a');
  const g = workspaceDir(root, null);
  const mine = addFact(a, { text: 'Moves on its own.' });
  // Not a duplicate of itself: the move goes through.
  expect(String(await reg.exec('memory', { action: 'update', id: mine.id, scope: 'global' }, ctx))).toContain('moved');
  expect(readFacts(g).map((f) => f.text)).toEqual(['Moves on its own.']);
  // A duplicate of a fact already in the target is refused, and nothing moves.
  const twin = addFact(a, { text: 'moves on its own' });
  expect(String(await reg.exec('memory', { action: 'update', id: twin.id, scope: 'global' }, ctx))).toContain('already remembered');
  expect(readFacts(a).some((f) => f.id === twin.id)).toBe(true);
  // A full target refuses a move too.
  for (let i = readFacts(g).length; i < 100; i++) addFact(g, { text: `global fact ${i}` });
  const one = addFact(a, { text: 'One more for global.' });
  expect(String(await reg.exec('memory', { action: 'update', id: one.id, scope: 'global' }, ctx))).toContain('the memory is full');
  expect(readFacts(g)).toHaveLength(100);
  expect(readFacts(a).some((f) => f.id === one.id)).toBe(true);
});

test('workspace_read is core — the memory index points at it — while workspace_write and workspace_list are the on-demand workspace group', () => {
  const { reg } = memSetup();
  const groupOf = (name: string) => reg.groups.find((g) => g.tools.some((t) => t.function.name === name));
  expect(groupOf('workspace_read')!.id).toBe('core');
  expect(groupOf('workspace_write')!.id).toBe('workspace');
  expect(groupOf('workspace_list')!.id).toBe('workspace');
  expect(groupOf('workspace_write')!.alwaysOn).toBe(false);
  // The read tool says how to reach the other two.
  const read = reg.tools.find((t) => t.function.name === 'workspace_read')!.function.description!;
  expect(read).toContain('tools_load');
  expect(read).toContain('workspace_write');
});

test('scope "plugin" keeps a fact for the calling plugin — named by its host-issued token only — and uninstalling the plugin removes it', async () => {
  const { root, reg, inProject } = memSetup();
  const g = workspaceDir(root, null);
  // A raw name beside the real token: only the token counts.
  const ctx = { ...inProject('/p/a'), pluginName: 'tracker', pluginToken: identityToken('keycaps') };
  expect(String(await reg.exec('memory', { action: 'add', text: 'The keycaps panel stays off.', scope: 'plugin' }, ctx))).toContain('Memory stored');
  expect(readFacts(g).map((f) => [f.text, f.plugin])).toEqual([['The keycaps panel stays off.', 'keycaps']]);
  expect(String(await reg.exec('memory', { action: 'list', scope: 'plugin' }, ctx))).toContain('keycaps panel');
  // Without a token there is no plugin to keep it for.
  expect(String(await reg.exec('memory', { action: 'add', text: 'x', scope: 'plugin' }, inProject('/p/a')))).toContain('plugin');
  expect(readFacts(g)).toHaveLength(1);
  await reg.exec('host:plugins_remove', { name: 'keycaps' }, {});
  expect(readFacts(g)).toEqual([]);
});

// A plugin whose groups change while the app runs (an MCP server that connects late)
// sets its plugin's `tools` and calls `refreshToolRegistry()`: the SAME registry object —
// the one the app and its services hold — and the chat's catalog carry the new group, and
// a group taken away is gone again.
test('refreshToolRegistry re-reads every plugin\'s tools into the registry already handed out', async () => {
  const { refreshToolRegistry, chatTools, chatToolGroupOf, chatGroupDescriptions } = await import('../tools');
  const make = makeFactory({});
  const plugin = make('late', { tools: [] });
  const reg = assembleToolRegistry({ plugins: [plugin], config: {}, repo: { list: async () => [] } as any });
  expect(reg.tools.map((t) => t.function.name)).not.toContain('late_ping');
  plugin.tools = [{ id: 'mcp:late', description: 'Pings.', tools: [{ type: 'function', function: { name: 'late_ping', description: 'Ping.', parameters: { type: 'object', properties: {} } } }], exec: async () => 'pong' }];
  refreshToolRegistry();
  expect(reg.tools.map((t) => t.function.name)).toContain('late_ping');
  expect(reg.groups.map((g) => g.id)).toContain('mcp:late');
  expect(chatTools().map((t) => t.function.name)).toContain('late_ping');
  expect(chatToolGroupOf().get('late_ping')).toBe('mcp:late');
  expect(chatGroupDescriptions().get('mcp:late')).toBe('Pings.');
  expect(await reg.exec('late_ping', {}, {})).toBe('pong');
  // host:tools_list sees it too.
  expect(String(await reg.exec('host:tools_list', {}, {}))).toContain('late_ping');
  plugin.tools = [];
  refreshToolRegistry();
  expect(reg.tools.map((t) => t.function.name)).not.toContain('late_ping');
  await expect(reg.exec('late_ping', {}, {})).rejects.toThrow(/Unknown tool/);
});
