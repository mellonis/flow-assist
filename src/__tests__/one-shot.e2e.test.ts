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

async function oneShot(model: ScriptedModel, allowWrites: boolean) {
  process.env.LLM_TOKEN = 'scripted';
  model.install();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-oneshot-')));
  const enabledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-oneshot-enabled-'));
  const memory = { file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-oneshot-memory-')), 'memory.json') };
  const config: Record<string, unknown> = { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all' }, fs: { roots: [root] }, memory };
  const repo = { enabledPlugins: async () => [], list: async () => [] } as never;
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
  expect(out).toContain('All done.');
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
  expect(err).toContain('$ echo made > made.txt');
  expect(err).not.toContain('config set');
});

test('--allow-writes is read before the prompt and is not a word of it', () => {
  expect(parseCli(['--allow-writes', 'fix', 'it'])).toEqual({ cmd: 'prompt', args: ['fix', 'it'], allowWrites: true });
  expect(parseCli(['fix', 'it'])).toEqual({ cmd: 'prompt', args: ['fix', 'it'] });
  expect(parseCli(['--allow-writes'])).toEqual({ cmd: 'prompt', args: [], allowWrites: true });
  // After the prompt has begun it is part of the text.
  expect(parseCli(['explain', '--allow-writes'])).toEqual({ cmd: 'prompt', args: ['explain', '--allow-writes'] });
});
