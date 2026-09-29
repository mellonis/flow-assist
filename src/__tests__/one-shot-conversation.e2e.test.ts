// The one-shot prompt as a conversation (`runPrompt` over a `oneshot` Conversation): what
// its model is told, what bounds its turn, what it prints and how it exits, which tools
// it is not offered, whose plan it keeps, and that it leaves no session behind.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatLanguage } from '../assistant/agent';
import { addFact } from '../assistant/memory-store';
import { firstStart } from '../assistant/memory-trust';
import { PLAN_REMINDER } from '../assistant/plan';
import { activeSecrets, refreshSecrets, setActiveSecrets } from '../assistant/secrets';
import { workspaceFor, workspaceRoot } from '../assistant/workspace';
import { acceptedConfigPath, hostStateDir } from '../config/load';
import { assembleToolRegistry, execChatTool } from '../loader/tools';
import { bgActiveCount } from '../loader/tools-core';
import { runPrompt } from '../main';
import { createPluginRepo } from '../loader/repo';
import { HOST_API } from '../version';
import { ScriptedModel } from './helpers/scripted';
import { listTree } from './helpers/session-files';

const realFetch = globalThis.fetch;
const realToken = process.env.LLM_TOKEN;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.LLM_TOKEN; else process.env.LLM_TOKEN = realToken;
});

type Msg = { role: string; content?: unknown };
const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
// stderr's lines, the note about an empty plugins directory left out.
const said = (err: string) => err.split('\n').filter((l) => l && !l.startsWith('[plugins]'));
const toolNames = (m: ScriptedModel, i: number) => ((m.requests[i] as { tools?: { function: { name: string } }[] }).tools ?? []).map((t) => t.function.name);
const toolResults = (m: ScriptedModel, i = -1) => (m.requests.at(i)!.messages as Msg[]).filter((x) => x.role === 'tool').map((x) => String(x.content));

async function oneShot(model: ScriptedModel, o: { prompt?: string[]; ai?: Record<string, unknown>; extra?: Record<string, unknown>; before?: (config: Record<string, unknown>, root: string) => void; fetch?: typeof fetch; allowWrites?: boolean; during?: (request: number) => void; repo?: unknown; enabledDir?: string } = {}) {
  process.env.LLM_TOKEN = '^scripted-llm-token';
  model.install();
  if (o.fetch) globalThis.fetch = o.fetch;
  // Something that happens while the turn runs: called with each request's index, before
  // the request is served.
  if (o.during) {
    const served = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => { o.during!(n++); return served(url, init); }) as typeof fetch;
  }
  const root = tmp('fa-oneshot2-');
  const config: Record<string, unknown> = {
    ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', ...o.ai },
    fs: { roots: [root] },
    memory: { file: path.join(tmp('fa-oneshot2-memory-'), 'memory.json') },
    workspace: { dir: tmp('fa-oneshot2-workspace-') },
    ...o.extra,
  };
  o.before?.(config, root);
  const repo = (o.repo ?? { enabledPlugins: async () => [], list: async () => [] }) as never;
  const out: string[] = []; const err: string[] = [];
  const code = await runPrompt(o.prompt ?? ['do', 'it'], config, repo, { enabledDir: o.enabledDir ?? tmp('fa-oneshot2-enabled-'), ...(o.allowWrites ? { allowWrites: true } : {}), out: (s) => out.push(s), err: (s) => err.push(s) });
  return { root, config, code, out: out.join(''), err: err.join('') };
}

// A known secret for one test's run, put back after it: the environment variable and the
// active set. The run's `before` calls `refreshSecrets(config)` to take it in.
const SECRET = 'oneshot-secret-4242-value';
const MARK = '‹secret FA_ONESHOT_API_TOKEN›';
async function withSecret(run: () => Promise<void>): Promise<void> {
  const before = activeSecrets();
  process.env.FA_ONESHOT_API_TOKEN = SECRET;
  try { await run(); } finally {
    delete process.env.FA_ONESHOT_API_TOKEN;
    setActiveSecrets(before);
  }
}

test('D17: the answer is printed once, when the turn ends — no step and no streamed text reach stdout', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Next: read the clock', tool: 'datetime', args: {} }], [{ text: 'It is noon.' }]);
  const r = await oneShot(model);
  expect(r.code).toBe(0);
  expect(r.out).toBe('It is noon.\n');
  expect(said(r.err)).toEqual([]);
});

test('Q3: a turn that ends with reasoning and no text prints one empty line — never an earlier step — and exits 0', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Next: read the clock', tool: 'datetime', args: {} }], [{ thinking: 'nothing more to say' }]);
  const r = await oneShot(model);
  expect(r.code).toBe(0);
  expect(r.out).toBe('\n');
  expect(said(r.err)).toEqual([]);
});

test('D4: the one-shot\'s model is told what the chat\'s is — the language and the Next: shape, who it talks to, the memory\'s index — and the project\'s instructions stay', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'ok' }]);
  const r = await oneShot(model, {
    extra: { user: { name: 'Ada Lovelace' } },
    before: (config, root) => {
      // The start's pass: the facts stored now are the host's (a one-shot never runs it).
      firstStart(workspaceRoot(config));
      addFact(workspaceFor(config, null, 'global'), { text: 'ONESHOT-FACT the person indents with tabs' });
      fs.writeFileSync(path.join(root, 'AGENTS.md'), 'ONESHOT-INSTRUCTIONS: run the tests before answering.\n');
    },
  });
  expect(r.code).toBe(0);
  const first = (model.requests[0]!.messages as Msg[])[0]!;
  expect(first.role).toBe('system');
  const system = String(first.content);
  expect(system).toContain(`Always respond in ${chatLanguage(r.config.ai as never)}`);
  expect(system).toContain('starts with "Next:"');
  expect(system).toContain('You are talking to Ada Lovelace');
  expect(system).toContain('ONESHOT-FACT');
  expect(system).toContain('ONESHOT-INSTRUCTIONS');
});

test('D5, D6: a one-shot turn stops at ai.maxRounds — the limit on stderr, nothing on stdout, exit code 2', async () => {
  const model = new ScriptedModel();
  model.script(...Array.from({ length: 3 }, () => [{ tool: 'datetime', args: {} }]), [{ text: 'never' }]);
  const r = await oneShot(model, { ai: { maxRounds: 2 } });
  expect(model.requests).toHaveLength(2);
  expect(r.code).toBe(2);
  expect(r.out).toBe('');
  expect(said(r.err)).toEqual(['flow-assist: stopped after 2 rounds (ai.maxRounds) — no answer; last step: datetime {}']);
});

test('D5, D6: a one-shot turn stops at ai.maxTurnTokens the same way', async () => {
  const model = new ScriptedModel();
  // A cache figure of 0: every prompt token is new; 610 a request, past 1000 after the second.
  model.usage = { prompt_tokens: 600, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } };
  model.script(...Array.from({ length: 4 }, () => [{ tool: 'datetime', args: {} }]), [{ text: 'never' }]);
  const r = await oneShot(model, { ai: { maxTurnTokens: 1000 } });
  expect(model.requests).toHaveLength(2);
  expect(r.code).toBe(2);
  expect(said(r.err)).toEqual(['flow-assist: stopped after 1220 tokens (ai.maxTurnTokens) — no answer; last step: datetime {}']);
});

test('D26: the one-shot is not offered background or remind, and a call to one answers as an unknown tool', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'background', args: { task: 'count the files' } }], [{ text: 'Could not.' }]);
  const r = await oneShot(model);
  const offered = toolNames(model, 0);
  expect(offered).not.toContain('background');
  // `subagent` is withheld by name; no tool of that name is registered today, so this
  // holds as a guard for when one is.
  expect(offered).not.toContain('subagent');
  expect(offered).not.toContain('remind');
  expect(offered).toContain('datetime');
  expect(toolResults(model)).toEqual(['ERROR: Unknown tool: background']);
  expect(bgActiveCount()).toBe(0);
  expect(r.out).toBe('Could not.\n');
});

test('D26: a plugin tool\'s own chatLLM in the one-shot is not offered background, subagent or remind either', async () => {
  // An enabled plugin whose tool asks the model through `ctx.chatLLM`.
  const enabledDir = tmp('fa-oneshot2-enabled-');
  const dir = path.join(enabledDir, 'asker');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'asker', version: '0.1.0', hostApi: HOST_API, tools: ['asker'] }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'asker', version: '0.1.0', type: 'module', main: './index.mjs' }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), `export default function ({ make }) {
  return make('asker', { name: 'asker', tools: [{ id: 'asker', tools: [{ type: 'function', function: { name: 'ask_model', description: 'Asks the model.', parameters: { type: 'object', properties: {} } } }],
    exec: async (_name, _args, ctx) => String((await ctx.chatLLM([{ role: 'user', content: 'look it up' }], {}))?.content ?? '') }] });
}
`);
  const repo = { enabledPlugins: async () => ['asker'], list: async () => [] };
  const model = new ScriptedModel();
  model.script([{ tool: 'ask_model', args: {} }], [{ text: 'nested done' }], [{ text: 'Done.' }]);
  const r = await oneShot(model, { repo, enabledDir });
  expect(r.out).toBe('Done.\n');
  expect(model.requests).toHaveLength(3);
  // Request 1 is the nested run's: it asks on its own messages.
  expect((model.requests[1].messages as Msg[]).some((m) => m.role === 'user' && m.content === 'look it up')).toBe(true);
  const nested = toolNames(model, 1);
  expect(nested).toContain('datetime');
  expect(nested).not.toContain('background');
  expect(nested).not.toContain('subagent');
  expect(nested).not.toContain('remind');
});

test('K8: the one-shot plans on its own plan — the reminder fires there, and the process\'s plan is left alone', async () => {
  assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as never });
  const before = await execChatTool('todo', { action: 'list' }, {});
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'todo', args: { action: 'set', todos: [{ text: 'one' }, { text: 'two' }] } }],
    [{ tool: 'datetime', args: {} }],
    [{ text: 'Done.' }],
  );
  await oneShot(model);
  const datetime = toolResults(model, 2).at(-1)!;
  expect(datetime).toStartWith('OK:');
  expect(datetime).toEndWith(PLAN_REMINDER);
  expect(await execChatTool('todo', { action: 'list' }, {})).toEqual(before);
});

test('the one-shot leaves no session behind — no state file, no journal, no lock — even with a sessions directory configured', async () => {
  const sessions = tmp('fa-oneshot2-sessions-');
  const model = new ScriptedModel();
  model.script([{ tool: 'datetime', args: {} }], [{ text: 'Noon.' }]);
  const r = await oneShot(model, { extra: { sessions: { dir: sessions } } });
  expect(r.code).toBe(0);
  expect(listTree(sessions)).toEqual([]);
});

test('a known secret the model writes reaches stdout only as its mark', async () => {
  const before = activeSecrets();
  process.env.FA_ONESHOT_API_TOKEN = 'oneshot-secret-4242-value';
  try {
    const model = new ScriptedModel();
    model.script([{ text: 'The token is oneshot-secret-4242-value, keep it safe.' }]);
    const r = await oneShot(model, { before: (config) => { refreshSecrets(config); } });
    expect(r.out).not.toContain('oneshot-secret-4242-value');
    expect(r.out).toContain('‹secret FA_ONESHOT_API_TOKEN›');
  } finally {
    delete process.env.FA_ONESHOT_API_TOKEN;
    setActiveSecrets(before);
  }
});

test('a failed turn says the provider\'s error on stderr, prints nothing and exits 1', async () => {
  const model = new ScriptedModel();
  const r = await oneShot(model, { fetch: (async () => new Response('upstream is down', { status: 500 })) as unknown as typeof fetch });
  expect(r.code).toBe(1);
  expect(r.out).toBe('');
  expect(said(r.err)).toHaveLength(1);
  expect(r.err).toContain('upstream is down');
});

test('an empty prompt is refused on stderr with exit code 1, and nothing is sent', async () => {
  const model = new ScriptedModel();
  const r = await oneShot(model, { prompt: ['  '] });
  expect(r.code).toBe(1);
  expect(model.requests).toHaveLength(0);
  expect(said(r.err)).toEqual(['flow-assist: the prompt is empty — flow-assist "your request"']);
});

test('the failure line is redacted: a known secret in the provider\'s error reaches stderr only as its mark', async () => {
  await withSecret(async () => {
    const model = new ScriptedModel();
    const r = await oneShot(model, {
      before: (config) => { refreshSecrets(config); },
      fetch: (async () => new Response(`upstream is down for ${SECRET}`, { status: 500 })) as unknown as typeof fetch,
    });
    expect(r.code).toBe(1);
    expect(said(r.err)).toHaveLength(1);
    expect(r.err).toContain('upstream is down');
    expect(r.err).not.toContain(SECRET);
    expect(r.err).toContain(MARK);
  });
});

test('the [write] line of --allow-writes is redacted: a known secret in the command is said only as its mark', async () => {
  await withSecret(async () => {
    const model = new ScriptedModel();
    model.script([{ tool: 'run_command', args: { command: `echo ${SECRET} > made.txt` } }], [{ text: 'Made.' }]);
    const r = await oneShot(model, { allowWrites: true, before: (config) => { refreshSecrets(config); } });
    expect(r.err).not.toContain(SECRET);
    expect(said(r.err)).toEqual([`[write] ! echo ${MARK} > made.txt`]);
  });
});

test('the limit line is redacted: a known secret in the last step\'s arguments is said only as its mark', async () => {
  await withSecret(async () => {
    const model = new ScriptedModel();
    // `datetime`'s one parameter is a free string; the step stays inside the 80-character cut.
    model.script([{ tool: 'datetime', args: {} }], [{ tool: 'datetime', args: { zone: SECRET } }], [{ text: 'never' }]);
    const r = await oneShot(model, { ai: { maxRounds: 2 }, before: (config) => { refreshSecrets(config); } });
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(said(r.err)).toHaveLength(1);
    expect(r.err).toContain('flow-assist: stopped after 2 rounds (ai.maxRounds) — no answer; last step: datetime');
    expect(r.err).not.toContain(SECRET);
    expect(r.err).toContain(MARK);
  });
});

test('a known secret the cut of the last step would go through is redacted before the cut — no part of it reaches stderr', async () => {
  await withSecret(async () => {
    const model = new ScriptedModel();
    // `datetime {"zone":"` is 18 characters; 52 more put the secret across the 80-character cut.
    model.script([{ tool: 'datetime', args: {} }], [{ tool: 'datetime', args: { zone: `${'z'.repeat(52)}${SECRET}` } }], [{ text: 'never' }]);
    const r = await oneShot(model, { ai: { maxRounds: 2 }, before: (config) => { refreshSecrets(config); } });
    expect(r.code).toBe(2);
    expect(said(r.err)).toHaveLength(1);
    expect(r.err).toContain(`last step: datetime {"zone":"${'z'.repeat(52)}‹secret`);
    expect(r.err).not.toContain(SECRET.slice(0, 8));
  });
});

test('a throw before the turn reaches the command line with a known secret as its mark', async () => {
  await withSecret(async () => {
    const config: Record<string, unknown> = { ai: { baseUrl: 'http://scripted.model', model: 'scripted' } };
    refreshSecrets(config);
    const repo = { enabledPlugins: async () => { throw new Error(`the plugins directory is unreadable: ${SECRET}`); }, list: async () => [] } as never;
    let thrown: unknown = null;
    try {
      await runPrompt(['do', 'it'], config, repo, { enabledDir: tmp('fa-oneshot2-enabled-'), out: () => {}, err: () => {} });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(`the plugins directory is unreadable: ${MARK}`);
  });
});

// The host's state directory — the settings files, the plugins' trust record — pointed at
// a scratch directory of the test's own for `run`: `XDG_CONFIG_HOME`, with NODE_ENV other
// than `test` (under `test` the process shares one directory), both put back after. It
// fails before `run` if the directory is not the scratch one, so nothing reaches another.
async function withOwnStateDir(run: (dir: string) => Promise<void>): Promise<void> {
  const scratch = tmp('fa-oneshot2-xdg-');
  const kept = { nodeEnv: process.env.NODE_ENV, xdg: process.env.XDG_CONFIG_HOME };
  process.env.XDG_CONFIG_HOME = scratch;
  process.env.NODE_ENV = 'oneshot-state-test';
  try {
    const dir = hostStateDir();
    expect(dir).toBe(path.join(scratch, 'flow-assist'));
    fs.mkdirSync(dir, { recursive: true });
    await run(dir);
  } finally {
    if (kept.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = kept.nodeEnv;
    if (kept.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = kept.xdg;
  }
}

test('a settings file changed during the run is said once at the end, not applied, and the exit code stays the turn\'s', async () => {
  await withOwnStateDir(async (dir) => {
    const files = ['config.json', 'config.local.json'].map((f) => path.join(dir, f));
    const accepted = () => (fs.existsSync(acceptedConfigPath()) ? fs.readFileSync(acceptedConfigPath(), 'utf8') : null);
    expect(accepted()).toBeNull();
    const model = new ScriptedModel();
    model.script([{ tool: 'datetime', args: {} }], [{ text: 'Noon.' }]);
    // Both files change on disk between the turn's two requests, by no write of the host's.
    const r = await oneShot(model, {
      during: (n) => { if (n === 1) for (const f of files) fs.writeFileSync(f, JSON.stringify({ ui: { verbs: ['Changed'] } })); },
    });
    expect(model.requests).toHaveLength(2);
    expect(r.code).toBe(0);
    expect(r.out).toBe('Noon.\n');
    // One line however many files changed.
    expect(said(r.err)).toEqual(['settings file changed outside flow-assist — not applied']);
    // Nothing applied: no accepted record was written.
    expect(accepted()).toBeNull();
  });
});

test('a plugin that fails to load is skipped on stderr with a known secret in its error said only as its mark', async () => {
  await withSecret(() => withOwnStateDir(async () => {
    // An enabled plugin whose builder throws with the secret in its message. The state
    // directory is new, so the first start trusts it and its code runs.
    const root = tmp('fa-oneshot2-plugins-');
    const avail = path.join(root, 'plugins-available');
    const enabled = path.join(root, 'plugins-enabled');
    const plug = path.join(avail, 'leaky');
    fs.mkdirSync(path.join(plug, 'src'), { recursive: true });
    fs.mkdirSync(enabled, { recursive: true });
    fs.writeFileSync(path.join(plug, 'package.json'), JSON.stringify({ name: 'leaky', main: './src/index.ts' }));
    fs.writeFileSync(path.join(plug, 'manifest.json'), JSON.stringify({ name: 'leaky', version: '1.0.0', hostApi: HOST_API }));
    fs.writeFileSync(path.join(plug, 'src', 'index.ts'), `export default function build() { throw new Error('cannot reach the server with ${SECRET}'); }`);
    fs.symlinkSync(plug, path.join(enabled, 'leaky'));
    const repo = createPluginRepo({ availableDir: avail, enabledDir: enabled, projectRoot: root });
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
    const model = new ScriptedModel();
    model.script([{ text: 'Fine.' }]);
    let r: Awaited<ReturnType<typeof oneShot>>;
    try {
      r = await oneShot(model, { repo, enabledDir: enabled, before: (config) => { refreshSecrets(config); } });
    } finally { console.warn = warn; }
    expect(r.code).toBe(0);
    const skip = warned.filter((l) => l.startsWith('[plugins] skip leaky:'));
    expect(skip).toEqual([`[plugins] skip leaky: cannot reach the server with ${MARK}`]);
    expect([...warned, r.err].join('\n')).not.toContain(SECRET.slice(0, 8));
  }));
});
