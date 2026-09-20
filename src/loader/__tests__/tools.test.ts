import { expect, test } from 'bun:test';
import { z } from 'zod';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assembleToolRegistry } from '../tools';
import { bgActiveCount } from '../tools-core.js';
import { makeFactory } from '../plugin';
import { loadMemories } from '../../runtime/services/memory.js';
import { identityToken } from '../../runtime/plugin-identity.js';

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
  expect(out).toContain('1');
  expect(out).toContain('write the test');
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
  expect(out).toContain('1 · a');
  expect(out).toContain('2 · b');
  expect(out).toContain('3 · c');
  expect(notifies).toBe(1);
  const list = await reg.exec('todo', { action: 'list' }, ctx);
  expect(list).toContain('☐ 1 · a');
  expect(list).toContain('☐ 3 · c');
  await reg.exec('todo', { action: 'clear' }, ctx);
});

test('todo set replaces the whole plan (full-replace) and keeps ids by text', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ctx = { notify: () => {} } as any;
  await reg.exec('todo', { action: 'set', todos: [{ text: 'a', status: 'in_progress' }, { text: 'b' }] }, ctx);
  let list = await reg.exec('todo', { action: 'list' }, ctx);
  expect(list).toContain('◐ 1 · a');
  expect(list).toContain('☐ 2 · b');
  // Re-set: 'a' keeps id 1 (now done), 'b' is dropped, new 'c' gets a fresh id.
  await reg.exec('todo', { action: 'set', todos: [{ text: 'a', status: 'done' }, { text: 'c' }] }, ctx);
  list = await reg.exec('todo', { action: 'list' }, ctx);
  expect(list).toContain('☑ 1 · a');
  expect(list).toContain('☐ 3 · c');
  expect(list).not.toContain('b');
  await reg.exec('todo', { action: 'clear' }, ctx);
});

test('todo set with an empty array clears the plan (done task leaves no stale plan)', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ctx = { notify: () => {} } as any;
  await reg.exec('todo', { action: 'set', todos: [{ text: 'a', status: 'done' }, { text: 'b', status: 'done' }] }, ctx);
  expect(await reg.exec('todo', { action: 'list' }, ctx)).toContain('☑ 1 · a');
  // Full-replace semantics allow "no remaining plan": an empty list empties the
  // plan (same as clear), so a finished task doesn't leave a stale ▾ plan.
  const out = await reg.exec('todo', { action: 'set', todos: [] }, ctx);
  expect(out).toContain('Plan cleared');
  expect(await reg.exec('todo', { action: 'list' }, ctx)).toContain('Plan is empty');
});

test('todo list reports open items first, then done, with ids', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ctx = { notify: () => {} } as any;
  await reg.exec('todo', { action: 'add', text: 'a' }, ctx);
  await reg.exec('todo', { action: 'add', text: 'b' }, ctx);
  await reg.exec('todo', { action: 'complete', id: 1 }, ctx);
  const list = await reg.exec('todo', { action: 'list' }, ctx);
  // Open items first (☐ b), then done (☑ a) — regardless of insertion order.
  const openIdx = list.indexOf('☐ 2 · b');
  const doneIdx = list.indexOf('☑ 1 · a');
  expect(openIdx).toBeGreaterThan(-1);
  expect(doneIdx).toBeGreaterThan(-1);
  expect(openIdx).toBeLessThan(doneIdx);
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
  expect(started).toContain('◐');
  expect(started).toContain('in progress');
  // Several in-progress items may coexist — starting id 2 must not reset id 1.
  await reg.exec('todo', { action: 'start', id: 2 }, ctx);
  const list = await reg.exec('todo', { action: 'list' }, ctx);
  expect(list).toContain('◐ 1 · a');
  expect(list).toContain('◐ 2 · b');
  await reg.exec('todo', { action: 'clear' }, ctx);
});

test('todo targets an item by text, not only by id', async () => {
  const make = makeFactory({});
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const ctx = { notify: () => {} } as any;
  await reg.exec('todo', { action: 'add', text: '73' }, ctx);
  await reg.exec('todo', { action: 'add', text: '42' }, ctx);
  // The model thinks in the number the user names ("73") — start/complete by text.
  const started = await reg.exec('todo', { action: 'start', text: '73' }, ctx);
  expect(started).toContain('◐ 1 · 73');
  const done = await reg.exec('todo', { action: 'complete', text: '73' }, ctx);
  expect(done).toContain('☑ 1 · 73');
  // A partial/insensitive match also resolves ("73" vs "№ 73").
  const sub = await reg.exec('todo', { action: 'start', text: '42' }, ctx);
  expect(sub).toContain('◐ 2 · 42');
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

test('the model gets no `config` and no `log` tool — only the read-only `config_schema`', () => {
  // Config is the model's own leash (disabledTools, baseUrl, tokenEnv, plugin
  // roots) and the assistant reads other people's text, so even a y/n-confirmed
  // write is one prompt injection plus one tired keypress away. The person owns
  // the values; the model sees the structure and proposes the command.
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const names = reg.tools.map((t) => t.function.name);
  expect(names).toContain('config_schema');
  expect(names).not.toContain('config');
  expect(names).not.toContain('log');
  expect(reg.tools.find((t) => t.function.name === 'config_schema')?.write).toBeUndefined();
});

test('config_schema shows structure, defaults and set/unset — never a value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-cfgschema-'));
  const local = join(dir, 'config.local.json');
  writeFileSync(local, JSON.stringify({ ai: { model: 'secret-model-name', baseUrl: 'https://llm.internal.example' }, user: { name: 'Ada Lovelace' } }));
  const reg = assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as any });
  const out = await reg.exec('config_schema', {}, { configLocalPath: local });
  expect(out).toMatch(/- ai\.model: string — set/);
  expect(out).toMatch(/- ai\.stream: true\|false — unset/);
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
  expect(await reg.exec('config_schema', { key: 'nope.nothing' }, {})).toMatch(/unknown key/);
});

test('config_schema reports EFFECTIVE key bindings and a plugin\'s own flags', async () => {
  const make = makeFactory({});
  const keycapsSchema = z.object({ enabled: z.boolean().optional(), colors: z.record(z.string(), z.unknown()).optional() }).optional();
  const plugins = [
    make('assistant', { keys: { chat: 'A' } }),
    make('keycaps', { configSchema: keycapsSchema, keys: {} }),
  ];
  const reg = assembleToolRegistry({ plugins, config: {}, repo: { list: async () => [] } as any });
  const out = await reg.exec('config_schema', {}, {});
  // Bindings are not personal data and are exactly what "how do I remap X" needs:
  // host defaults + plugin keys, not the (empty) override map.
  expect(out).toMatch(/chat: A/);
  expect(out).toMatch(/quit: q/);
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
  await reg.exec('tracker:open_issue', {}, { openBrowser: hostOpenBrowser });
  // The plugin's own services are fused into the run ctx (openIssue stub present).
  expect(typeof seen.ctx.openIssue).toBe('function');
  expect(seen.ctx.openIssue('ABC-1')).toContain('STUB openIssue ABC-1');
  // The CALLER's service wins on a shared key (host openBrowser beats the stub).
  expect(seen.ctx.openBrowser).toBe(hostOpenBrowser);
  expect(seen.ctx.openBrowser('x')).toContain('REAL openBrowser x');
  // The host-issued plugin token is injected (identity), not a spoofable name.
  expect(seen.ctx.pluginToken).toBe(identityToken('tracker'));
});

test('memory plugin scope resolves ONLY from a host-issued token, not a caller-supplied name', async () => {
  const make = makeFactory({});
  const plugins = [make('keycaps', { keys: {} })];
  const memFile = join(tmpdir(), `fa-mem-token-${Date.now()}.json`);
  const config = { memory: { file: memFile } };
  const reg = assembleToolRegistry({ plugins, config, repo: { list: async () => [] } as any });
  // A mixed ctx: a raw `pluginName` string AND the real host token. The string is
  // the fake identity; only the token counts.
  const ctx = { memoryFile: memFile, pluginName: 'tracker' as string, pluginToken: identityToken('keycaps') };
  await reg.exec('memory', { action: 'add', text: 'keycap note', scope: 'plugin' }, ctx);
  // The note is attributed to the TOKEN's owner (keycaps), not the spoofed 'tracker'.
  const mems = await reg.exec('memory', { action: 'list', scope: 'plugin' }, ctx);
  expect(mems).toContain('keycap note');
  expect(loadMemories(memFile).some(m => m.scope === 'keycaps')).toBe(true);
  expect(loadMemories(memFile).some(m => m.scope === 'tracker')).toBe(false);
});

test('memory tool enforces host|plugin scope, resolves plugin, and supports a label', async () => {
  const make = makeFactory({});
  const plugins = [make('keycaps', { keys: {} })];
  const memFile = join(tmpdir(), `fa-mem-scope-${Date.now()}.json`);
  const config = { memory: { file: memFile } };
  const reg = assembleToolRegistry({ plugins, config, repo: { list: async () => [] } as any });
  const ctx = { memoryFile: memFile };

  // Default scope is host (assistant's own memory).
  await reg.exec('memory', { action: 'add', text: 'cache is ON by default', label: 'config' }, ctx);
  // 'plugin' scope resolves to the current plugin name (the host knows it).
  await reg.exec('memory', { action: 'add', text: 'keycaps panel flag', scope: 'plugin', label: 'keycaps' }, { ...ctx, pluginToken: identityToken('keycaps') });

  // An invalid scope is rejected instead of being stored verbatim.
  const bad = await reg.exec('memory', { action: 'add', text: 'x', scope: 'issue:42' }, ctx);
  expect(bad).toContain('invalid scope');

  // Label filter narrows recall by topic; scope filter narrows by owner.
  const configMems = await reg.exec('memory', { action: 'list', label: 'config' }, ctx);
  expect(configMems).toContain('cache is ON by default');
  expect(configMems).not.toContain('keycaps panel');
  const pluginMems = await reg.exec('memory', { action: 'list', scope: 'plugin', label: 'keycaps' }, { ...ctx, pluginToken: identityToken('keycaps') });
  expect(pluginMems).toContain('keycaps panel');

  // list renders the label so the assistant can see it (`(scope) [label] text`).
  const all = await reg.exec('memory', { action: 'list', label: 'config' }, ctx);
  expect(all).toMatch(/\(host\) \[config\] cache is ON by default/);

  // update can change the label.
  const listed = await reg.exec('memory', { action: 'list', label: 'config' }, ctx);
  const id = (listed.match(/\[(m-[^\]]+)\]/)?.[1]) ?? '';
  expect(id).toBeTruthy();
  await reg.exec('memory', { action: 'update', id, label: 'host:misc' }, ctx);
  const relabeled = await reg.exec('memory', { action: 'list', label: 'host:misc' }, ctx);
  expect(relabeled).toContain('cache is ON by default');
});

test('host:plugins_remove purges the removed plugin\'s scoped memories', async () => {
  const make = makeFactory({});
  const plugins = [make('keycaps', { keys: {} })];
  const memFile = join(tmpdir(), `fa-mem-purge-${Date.now()}.json`);
  const config = { memory: { file: memFile } };
  const repo = { list: async () => [], remove: async () => ({ ok: true }) } as any;
  const reg = assembleToolRegistry({ plugins, config, repo });
  // One host-scoped fact, one keycaps-scoped fact (scope 'plugin' → 'keycaps').
  await reg.exec('memory', { action: 'add', text: 'host note' }, { memoryFile: memFile });
  await reg.exec('memory', { action: 'add', text: 'keycap note', scope: 'plugin', label: 'keycaps' }, { memoryFile: memFile, pluginToken: identityToken('keycaps') });
  expect(loadMemories(memFile).some(m => m.scope === 'keycaps')).toBe(true);

  // Uninstalling keycaps drops its facts; the host-scoped one survives.
  await reg.exec('host:plugins_remove', { name: 'keycaps' }, {});
  const mems = loadMemories(memFile);
  expect(mems.some(m => m.scope === 'keycaps')).toBe(false);
  expect(mems.some(m => m.scope === 'host')).toBe(true);
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
