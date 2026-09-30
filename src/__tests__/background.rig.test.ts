// The `background` tool end to end (AGENTS.md, "A conversation starts a child of its
// own"): a task is a child conversation of the one whose turn called the tool — its
// requests carry the worker prompt, its writes are declined, its result comes back as the
// toast, the log line and an inbox row — and it runs in the host's slots, under the
// configured chain depth, with its own abort and its round cap said.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Make } from '../loader/plugin.ts';
import { ScriptedModel, type RecordedRequest } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; closeRigs(); });

const WORKER = 'You are a background worker';
const system = (req: RecordedRequest): string => String(req.messages.find((m) => m.role === 'system')?.content ?? '');
// A task's requests, apart from the chat's: the worker prompt names the task.
const taskScript = (model: ScriptedModel, task: string) => model.when((req) => system(req).includes(WORKER) && system(req).includes(`Task: ${task}`));
// The results that landed in the chat as inbox rows.
const delivered = (rig: Rig): string[] => rig.conv.rows().filter((m) => m.role === 'bg').map((m) => String(m.content));
// A task is over when nothing is in flight and its result has landed; a test waits for
// both before it returns, or a request of the task would reach the real fetch.
const settled = (rig: Rig, results: number) => rig.until(() => rig.registry.children.backgroundCount() === 0 && delivered(rig).length === results);
const taskCall = (rig: Rig, label: string, name: string) => rig.journal().find((e) => e.t === 'call' && e.task === label && e.name === name);

test('a task runs in the background and reports back', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'run the build', label: 'build' } }], [{ text: 'Started.' }]);
  const task = taskScript(model, 'run the build');
  task.script([{ tool: 'run_command', args: { command: 'echo x > made.txt' } }], [{ text: 'build ok' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  // The count the chat would draw at each notify. The turn's ctx reads the host's
  // services when it is built.
  const counts: number[] = [];
  (rig.services as unknown as { notify: () => void }).notify = () => { counts.push(rig.registry.children.backgroundCount()); };
  await rig.conv.send('build it in the background');
  const answer = rig.journal().find((e) => e.t === 'call' && !e.task && e.name === 'background');
  expect(String(answer?.result)).toContain('Background task started (build)');
  await settled(rig, 1);
  // The task's request reached the scripted endpoint with the host's credentials, and its
  // system prompt grounds time in the `datetime` tool.
  expect(task.urls[0]).toStartWith('http://scripted.model');
  expect(task.headers[0]!.authorization).toBe('Bearer ^scripted-llm-token');
  const sys = system(task.requests[0]!);
  expect(sys).toContain('`datetime` tool');
  expect(sys).toContain('stale');
  expect(sys).toContain('Task: run the build');
  expect(rig.log).toContain('[bg] build: build ok');
  expect(rig.toasts).toContain('⏳ build done');
  // No "[background]" prefix: the row's role marks it.
  expect(delivered(rig)).toEqual(['build finished:\nbuild ok']);
  // Once when the task is armed, once when it ends — after its slot frees, so the last
  // render shows none in the background.
  await rig.until(() => counts.length === 2);
  expect(counts).toEqual([1, 0]);
  // Its write was declined — the task has nobody to answer a y/n.
  expect(fs.existsSync(path.join(rig.root, 'made.txt'))).toBe(false);
  expect(rig.journal().find((e) => e.t === 'confirm' && e.task === 'build')).toMatchObject({ answer: 'no', by: 'background' });
});

test('a delayed task is counted from arming and says when it starts', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'x', label: 'late', in: '3 minutes' } }], [{ text: 'Scheduled.' }]);
  const rig = conversationRig(model);
  await rig.conv.send('later, please');
  const answer = rig.journal().find((e) => e.t === 'call' && e.name === 'background');
  expect(String(answer?.result)).toContain('in 180s');
  // In flight though not started: the chat's `N in background` counts it.
  expect(rig.registry.children.backgroundCount()).toBe(1);
  expect(rig.registry.children.running()).toBe(0);
  expect(rig.log.filter((l) => l.startsWith('[bg]'))).toEqual([]);
  expect(model.requests.some((r) => system(r).includes(WORKER))).toBe(false);
  rig.registry.children.cancelArmed();
  expect(rig.registry.children.backgroundCount()).toBe(0);
});

test('bursts are queued, not dropped: five tasks from one turn all deliver, at most three at once', async () => {
  const model = new ScriptedModel();
  for (let i = 0; i < 5; i++) taskScript(model, `t${i}`).script([{ text: `r${i}` }]);
  model.script(
    [0, 1, 2, 3, 4].map((i) => ({ tool: 'background', args: { task: `t${i}`, label: `t${i}` } })),
    [{ text: 'Started five.' }],
  );
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  // Each task's request takes a while, so the tasks overlap and the cap engages.
  let concurrent = 0, peak = 0;
  const served = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const isTask = String(init?.body).includes(WORKER);
    if (isTask) { concurrent++; peak = Math.max(peak, concurrent); await new Promise((r) => setTimeout(r, 30)); }
    try { return await served(url, init); } finally { if (isTask) concurrent--; }
  }) as typeof fetch;
  await rig.conv.send('five at once');
  const answers = rig.journal().filter((e) => e.t === 'call' && e.name === 'background').map((e) => String(e.result));
  expect(answers).toHaveLength(5);
  for (const a of answers) expect(a).toContain('Background task started');
  await settled(rig, 5);
  expect([...delivered(rig)].sort()).toEqual([0, 1, 2, 3, 4].map((i) => `t${i} finished:\nr${i}`));
  expect(peak).toBeLessThanOrEqual(3);
  expect(peak).toBeGreaterThan(1);
});

test('a task cannot put a question to the person: ask_user answers "nobody to ask"', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'ask', label: 'q' } }], [{ text: 'Started.' }]);
  taskScript(model, 'ask').script(
    [{ tool: 'ask_user', args: { questions: [{ question: 'q?', options: [{ label: 'a' }, { label: 'b' }] }] } }],
    [{ text: 'assumed a' }],
  );
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  await rig.conv.send('go');
  await settled(rig, 1);
  expect(String(taskCall(rig, 'q', 'ask_user')?.result)).toMatch(/nobody to ask/i);
  expect(rig.conv.questionDrawn).toBeNull();
});

test('a task reads the project instructions for its own shell, and its cd answers from its own reading', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'look at proj', label: 'p' } }], [{ text: 'Started.' }]);
  const task = taskScript(model, 'look at proj');
  task.script([{ tool: 'cd', args: { path: 'proj' } }], [{ text: 'seen' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  fs.mkdirSync(path.join(rig.root, 'proj'));
  fs.writeFileSync(path.join(rig.root, 'proj', 'AGENTS.md'), 'BG RULE');
  fs.writeFileSync(path.join(rig.root, 'AGENTS.md'), 'CHAT RULE');
  await rig.conv.send('go');
  await settled(rig, 1);
  const first = system(task.requests[0]!);
  const second = system(task.requests[1]!);
  // It starts where the chat's shell is, and reads that directory itself.
  expect(first).toContain('CHAT RULE');
  expect(first).not.toContain('BG RULE');
  expect(second).toContain('## Project instructions');
  expect(second).toContain('BG RULE');
  expect(String(taskCall(rig, 'p', 'cd')?.result)).toContain(path.join(rig.root, 'proj', 'AGENTS.md'));
  // Its cd moved its own shell only.
  expect(rig.conv.shell.cwd()).toBe(rig.root);
});

const OTHER = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-bg-other-')));
test('a task works in its conversation\'s project, whatever its shell does', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'remember', label: 'm' } }], [{ text: 'Started.' }]);
  taskScript(model, 'remember').script(
    [{ tool: 'cd', args: { path: OTHER } }],
    [{ tool: 'memory', args: { action: 'add', text: 'Found by the background task.' } }],
    [{ text: 'saved' }],
  );
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  (rig.config.shell as { roots: string[] }).roots.push(OTHER);
  await rig.conv.send('go');
  await settled(rig, 1);
  expect(String(taskCall(rig, 'm', 'cd')?.result)).toContain(OTHER);
  const project = rig.conv.currentProject();
  expect(project).not.toBeNull();
  expect(project).not.toBe(OTHER);
  expect(rig.conv.memoryLists().project.map((f) => f.text)).toContain('Found by the background task.');
});

test('a task at its round cap says so', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'loop', label: 'L' } }], [{ text: 'Started.' }]);
  const task = taskScript(model, 'loop');
  task.script(...Array.from({ length: 12 }, () => [{ tool: 'datetime', args: {} }]));
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false } });
  await rig.conv.send('go');
  await settled(rig, 1);
  expect(task.requests).toHaveLength(12);
  expect(delivered(rig)).toEqual(['L finished:\n(no output)\nstopped after 12 rounds — last: datetime {}']);
});

test('a task at the token budget says so', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'spend', label: 'T' } }], [{ text: 'Started.' }]);
  const task = taskScript(model, 'spend');
  task.usage = { prompt_tokens: 600, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } };
  task.script(...Array.from({ length: 4 }, () => [{ tool: 'datetime', args: {} }]), [{ text: 'never' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false, maxTurnTokens: 1000 } });
  await rig.conv.send('go');
  await settled(rig, 1);
  expect(delivered(rig)).toEqual(['T finished:\n(no output)\nstopped at the token budget after 2 rounds — last: datetime {}']);
});

test('a non-numeric sessions.maxRunning still runs tasks, three at a time', async () => {
  const model = new ScriptedModel();
  for (let i = 0; i < 5; i++) taskScript(model, `t${i}`).script([{ text: `r${i}` }]);
  model.script(
    [0, 1, 2, 3, 4].map((i) => ({ tool: 'background', args: { task: `t${i}`, label: `t${i}` } })),
    [{ text: 'Started five.' }],
  );
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false }, extra: { sessions: { maxRunning: 'many' } } });
  let concurrent = 0, peak = 0;
  const served = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const isTask = String(init?.body).includes(WORKER);
    if (isTask) { concurrent++; peak = Math.max(peak, concurrent); await new Promise((r) => setTimeout(r, 30)); }
    try { return await served(url, init); } finally { if (isTask) concurrent--; }
  }) as typeof fetch;
  await rig.conv.send('five at once');
  await settled(rig, 5);
  expect(delivered(rig)).toHaveLength(5);
  expect(peak).toBe(3);
});

test('the parent\'s Esc does not reach a task\'s tool', async () => {
  let entered = false;
  let seen: AbortSignal | undefined;
  let open = () => {};
  const gate = new Promise<void>((r) => { open = r; });
  const probe = (make: Make) => make('probe', {
    tools: [{
      id: 'probe',
      tools: [{ type: 'function', function: { name: 'probe_signal', description: 'Waits, then reads its signal.', parameters: { type: 'object', properties: {} } } }],
      exec: async (_name: string, _args: unknown, ctx: Record<string, unknown>) => {
        seen = ctx.signal as AbortSignal | undefined;
        entered = true;
        await gate;
        return `aborted=${seen?.aborted}`;
      },
    }],
  });
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'probe', label: 'p' } }], [{ hold: true }, { text: 'never' }]);
  taskScript(model, 'probe').script([{ tool: 'probe_signal', args: {} }], [{ text: 'probed' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false }, guests: (make) => [probe(make)] });
  const turn = rig.conv.send('go');
  // The task's tool waits while the chat's turn is still on its held second round.
  await rig.until(() => entered && model.held);
  expect(rig.conv.stop('')).toBe(true);
  await turn;
  open();
  await settled(rig, 1);
  expect(seen).toBeInstanceOf(AbortSignal);
  expect(seen!.aborted).toBe(false);
  expect(String(taskCall(rig, 'p', 'probe_signal')?.result)).toBe('aborted=false');
});

test('a chain refuses at the configured depth', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'one', label: 'a' } }], [{ text: 'Started.' }]);
  taskScript(model, 'one').script([{ tool: 'background', args: { task: 'two', label: 'b' } }], [{ text: 'a done' }]);
  const rig = conversationRig(model, { inbox: true, ai: { backgroundFollowUp: false, subagentDepth: 1 } });
  await rig.conv.send('go');
  await settled(rig, 1);
  expect(String(taskCall(rig, 'a', 'background')?.result)).toContain('depth exceeded (max 1)');
  expect(model.requests.some((r) => system(r).includes('Task: two'))).toBe(false);
  expect(delivered(rig)).toEqual(['a finished:\na done']);
});
