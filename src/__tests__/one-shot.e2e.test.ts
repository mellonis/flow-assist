// The one-shot prompt (`flow-assist "<prompt>"`) through its real path: the plugins
// loaded from an empty enabled dir, the tool registry, the host services and the agent
// loop, with only the model scripted. A one-shot run has nobody to answer a y/n, so it
// declines every write unless the person passed `--allow-writes`, and then each write
// is said on stderr as it runs.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel } from './helpers/scripted';
import { parseCli, runPrompt } from '../main';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Sent = { role: string; content: unknown }[];
const toolResults = (m: ScriptedModel) => (m.requests.at(-1)!.messages as Sent).filter((x) => x.role === 'tool').map((x) => String(x.content));

// A plugin of the enabled dir's own that declares a write-flagged tool of the host
// shell's name — registered qualified, `fakesh:run_command` — and records each run.
function fakeShellPlugin(enabledDir: string, ranFile: string) {
  const dir = path.join(enabledDir, 'fakesh');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'fakesh', version: '0.1.0', hostApi: 2, tools: ['fakesh'] }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fakesh', version: '0.1.0', type: 'module', main: './index.mjs' }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), `import fs from 'node:fs';
export default function ({ make }) {
  return make('fakesh', { name: 'fakesh', tools: [{ id: 'fakesh', tools: [{ type: 'function', function: { name: 'run_command', description: 'Runs.', parameters: { type: 'object', properties: { command: { type: 'string' } } } }, write: true }],
    exec: async () => { fs.writeFileSync(${JSON.stringify(ranFile)}, 'ran'); return 'ran'; } }] });
}
`);
}

async function oneShot(model: ScriptedModel, allowWrites: boolean, withPlugin = false) {
  process.env.LLM_TOKEN = '^scripted-llm-token';
  model.install();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-oneshot-')));
  const enabledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-oneshot-enabled-'));
  if (withPlugin) fakeShellPlugin(enabledDir, path.join(root, 'plugin-ran'));
  const memory = { file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-oneshot-memory-')), 'memory.json') };
  const config: Record<string, unknown> = { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all' }, fs: { roots: [root] }, memory };
  const repo = { enabledPlugins: async () => (withPlugin ? ['fakesh'] : []), list: async () => [] } as never;
  const out: string[] = []; const err: string[] = [];
  await runPrompt(['make', 'the', 'file'], config, repo, { allowWrites, enabledDir, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { root, out: out.join(''), err: err.join('') };
}

const script = (model: ScriptedModel) => model.script(
  [
    { tool: 'run_command', args: { command: 'echo made > made.txt' } },
    { tool: 'memory', args: { action: 'list' } },
    { tool: 'config_set', args: { key: 'ui.verbs', value: '["Pondering"]', scope: 'session' } },
  ],
  [{ text: 'All done.' }],
);

test('a one-shot run declines every write, tells the model why, and still runs a read', async () => {
  const model = new ScriptedModel();
  script(model);
  const { root, out, err } = await oneShot(model, false);
  expect(fs.existsSync(path.join(root, 'made.txt'))).toBe(false);
  const [command, read, config] = toolResults(model);
  expect(command).toStartWith('DECLINED:');
  expect(command).toContain('cannot ask the person');
  expect(read).toStartWith('OK:');
  expect(config).toStartWith('DECLINED:');
  expect(out).toBe('All done.\n');
  expect(err).not.toContain('echo made');
});

test('with --allow-writes a write runs and is said on stderr; config_set still declines', async () => {
  const model = new ScriptedModel();
  script(model);
  const { root, err } = await oneShot(model, true);
  expect(fs.readFileSync(path.join(root, 'made.txt'), 'utf8')).toBe('made\n');
  const [command, read, config] = toolResults(model);
  expect(command).toStartWith('OK:');
  expect(read).toStartWith('OK:');
  // Config is the person's: the flag is no yes to it, as the auto mode never is.
  expect(config).toStartWith('DECLINED:');
  expect(err).toContain('! echo made > made.txt');
  expect(err).not.toContain('config set');
});

// The stderr line is the flag's only safeguard, so a command cannot hide on it: an
// escape sequence or a carriage return written into the command is dropped, and every
// line of a command of several lines is marked as the write's.
test('with --allow-writes the stderr line keeps no escape code or carriage return, and marks every line of the command', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'run_command', args: { command: 'echo made > made.txt\u001b[1A\u001b[2K\rtrue\necho two' } }],
    [{ text: 'All done.' }],
  );
  const { err } = await oneShot(model, true);
  expect(err).not.toContain('\u001b');
  expect(err).not.toContain('\r');
  const lines = err.trimEnd().split('\n').filter((l) => !l.startsWith('[plugins]'));
  expect(lines).toEqual(['[write] ! echo made > made.txt', '[write]   true', '[write]   echo two']);
});

// The flag is a yes to what the auto mode may answer with `shell.autoRun` on, and no
// more: a fetch outside `web.allowlist` can carry out what the model has read, and a
// plugin's tool of the shell's name is not the host's shell.
test('with --allow-writes an unlisted web_fetch and a plugin\'s run_command are still declined', async () => {
  const model = new ScriptedModel();
  model.script(
    [
      { tool: 'web_fetch', args: { url: 'https://example.invalid/page' } },
      { tool: 'fakesh:run_command', args: { command: 'echo hi' } },
    ],
    [{ text: 'All done.' }],
  );
  const { root, err } = await oneShot(model, true, true);
  const [fetch, command] = toolResults(model);
  expect(fetch).toStartWith('DECLINED:');
  expect(command).toStartWith('DECLINED:');
  expect(fs.existsSync(path.join(root, 'plugin-ran'))).toBe(false);
  expect(err).not.toContain('[write]');
});

test('--allow-writes is read before the prompt and is not a word of it', () => {
  expect(parseCli(['--allow-writes', 'fix', 'it'])).toEqual({ cmd: 'prompt', args: ['fix', 'it'], allowWrites: true });
  expect(parseCli(['fix', 'it'])).toEqual({ cmd: 'prompt', args: ['fix', 'it'] });
  expect(parseCli(['--allow-writes'])).toEqual({ cmd: 'prompt', args: [], allowWrites: true });
  // After the prompt has begun it is part of the text.
  expect(parseCli(['explain', '--allow-writes'])).toEqual({ cmd: 'prompt', args: ['explain', '--allow-writes'] });
});
