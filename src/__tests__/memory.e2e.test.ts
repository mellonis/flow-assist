// What /clear clears, and what it does not — as a person meets it.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Every fact file under a workspace root, by its text.
const factsUnder = (root: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md') && e.name !== 'MEMORY.md' && d.endsWith('memory')) out.push(readFileSync(p, 'utf8').split('---\n')[2]!.trim());
    }
  };
  walk(root);
  return out;
};
const systemOf = (model: ScriptedModel) => JSON.stringify(model.requests.at(-1)!.messages.filter((m) => m.role === 'system'));

test('after /clear the assistant still has its memory — and the chat says so, and /memory removes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-ws-'));
  const model = new ScriptedModel();
  model.script(
    // The model decides to remember the prompt — nobody sees more than "1 tool: memory".
    [{ tool: 'memory', args: { action: 'add', text: 'Prompt "focus": think of 7 random numbers and plan them' } }],
    [{ text: 'Done.' }],
    [{ text: 'second' }],
    [{ text: 'third' }],
  );
  const ui = await bootApp(model, 110, 30, undefined, { workspace: { dir } });
  await ui.press('F');
  await ui.type('think of 7 numbers');
  await ui.press('return');
  await settle(24);
  expect(factsUnder(dir)).toEqual(['Prompt "focus": think of 7 random numbers and plan them']);

  await ui.type('/clear');
  await ui.press('return');
  await settle();
  // The conversation is gone; the memory is not — and that is SAID. Silent, it read
  // as "/clear does not work: the assistant still knows what I asked".
  expect(ui.backend.lastFrame).not.toContain('think of 7 numbers');
  expect(ui.backend.lastFrame).toContain('1 memory is kept');
  expect(ui.backend.lastFrame).toContain('/memory');

  // The next request: no trace of the old turn in the MESSAGES, the fact's line in the
  // system prompt's index.
  await ui.type('hello again');
  await ui.press('return');
  await settle(20);
  const sent = model.requests.at(-1)!.messages;
  expect(sent.filter((m) => m.role !== 'system')).toEqual([{ role: 'user', content: 'hello again' }]);
  expect(systemOf(model)).toContain('7 random numbers');
  expect(systemOf(model)).toContain('](memory/');
  // The note itself is for the person only.
  expect(JSON.stringify(sent)).not.toContain('is kept');

  // /memory shows it without asking the model…
  const before = model.requests.length;
  await ui.type('/memory');
  await ui.press('return');
  await settle();
  expect(ui.backend.lastFrame).toContain('1 memory — each one');
  expect(ui.backend.lastFrame).toContain('This project');
  expect(ui.backend.lastFrame).toContain('7 random numbers');
  // …and removes it.
  await ui.type('/memory forget 1');
  await ui.press('return');
  await settle();
  expect(ui.backend.lastFrame).toContain('Forgot:');
  expect(factsUnder(dir)).toEqual([]);
  expect(model.requests.length).toBe(before);

  // From now on the model does not know it either.
  await ui.type('and now');
  await ui.press('return');
  await settle(20);
  expect(JSON.stringify(model.requests.at(-1)!.messages)).not.toContain('7 random numbers');
  ui.app.unmount();
});

test('a fact of project A never reaches project B\'s prompt; a global one reaches both — as an index line, never the fact\'s text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-ws-'));
  const repo = () => {
    const r = realpathSync(mkdtempSync(join(tmpdir(), 'fa-proj-')));
    mkdirSync(join(r, '.git'));
    return r;
  };
  const a = repo();
  const b = repo();

  const modelA = new ScriptedModel();
  modelA.script(
    [
      { tool: 'memory', args: { action: 'add', text: 'The build of this repo needs QUAGGA set.', name: 'Build variable', description: 'what the build needs' } },
      { tool: 'memory', args: { action: 'add', text: 'The person wants answers without TAPIR words.', name: 'Answer style', description: 'how to answer', scope: 'global' } },
    ],
    [{ text: 'Noted.' }],
    [{ text: 'ok' }],
  );
  const uiA = await bootApp(modelA, 110, 30, undefined, { workspace: { dir }, shell: { roots: [a] } });
  await uiA.press('F');
  await uiA.type('remember two things');
  await uiA.press('return');
  await settle(24);
  await uiA.type('and?');
  await uiA.press('return');
  await settle(20);
  // In A: both lines of the index — and neither fact's own text, which is read with
  // workspace_read when a line is relevant.
  expect(systemOf(modelA)).toContain('[Build variable](memory/build-variable.md) — what the build needs');
  expect(systemOf(modelA)).toContain('[Answer style](memory/answer-style.md) — how to answer');
  expect(systemOf(modelA)).not.toContain('QUAGGA');
  expect(systemOf(modelA)).not.toContain('TAPIR');
  expect(systemOf(modelA)).toContain('your own notes');
  uiA.app.unmount();

  const modelB = new ScriptedModel();
  modelB.script([{ text: 'hi' }]);
  const uiB = await bootApp(modelB, 110, 30, undefined, { workspace: { dir }, shell: { roots: [b] } });
  await uiB.press('F');
  await uiB.type('hello');
  await uiB.press('return');
  await settle(20);
  expect(systemOf(modelB)).not.toContain('Build variable');
  expect(systemOf(modelB)).toContain('[Answer style](memory/answer-style.md)');
  uiB.app.unmount();
});

test('a test that stores a memory leaves the config directory alone', async () => {
  // The person's own `memory.json` held 32 copies of one fact, one per test run: the
  // app boots, the model calls `memory`, and with no file named the write landed in
  // the config directory. Point the config directory at a temp dir of this test's own
  // and nothing may appear under it — not the memory, not the cache, not the log.
  const cfgHome = mkdtempSync(join(tmpdir(), 'fa-xdg-'));
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfgHome;
  try {
    const model = new ScriptedModel();
    model.script(
      [{ tool: 'memory', args: { action: 'add', text: 'This repo prefers rebase over merge' } }],
      [{ text: 'Noted.' }],
      [{ text: 'and again' }],
    );
    // No `memory.file`: exactly the shape every other e2e test has.
    const ui = await bootApp(model, 110, 30);
    await ui.press('F');
    await ui.type('remember how this repo works');
    await ui.press('return');
    await settle(24);
    // The fact was stored — it is in the system prompt of the next request…
    await ui.type('what do you know');
    await ui.press('return');
    await settle(20);
    const sent = model.requests.at(-1)!.messages;
    expect(JSON.stringify(sent.filter((m) => m.role === 'system'))).toContain('rebase over merge');
    // …and nowhere near the config directory.
    expect(existsSync(join(cfgHome, 'flow-assist'))).toBe(false);
    ui.app.unmount();
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
  }
});

test('/clear with an empty memory says nothing extra', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fa-mem-')), 'memory.json');
  const model = new ScriptedModel();
  model.script([{ text: 'hi' }]);
  const ui = await bootApp(model, 110, 26, undefined, { memory: { file } });
  await ui.press('F');
  await ui.type('hello');
  await ui.press('return');
  await settle(16);
  await ui.type('/clear');
  await ui.press('return');
  await settle();
  expect(ui.backend.lastFrame).not.toContain('kept');
  expect(ui.backend.lastFrame).toContain('Ask anything.');
  ui.app.unmount();
});

test('the first start moves memory.json into the global workspace and says so; the next start moves nothing and says nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-ws-'));
  const file = join(mkdtempSync(join(tmpdir(), 'fa-mem-')), 'memory.json');
  writeFileSync(file, JSON.stringify({ memories: [
    { id: 'm-1', text: 'Prefers rebase over merge.', scope: 'host', ts: 1 },
    { id: 'm-2', text: 'Answers in Russian.', scope: 'host', ts: 2 },
  ] }));
  const model = new ScriptedModel();
  model.script([{ text: 'hi' }], [{ text: 'again' }]);
  const ui = await bootApp(model, 110, 30, undefined, { workspace: { dir }, memory: { file } });
  await ui.press('F');
  await settle(10);
  expect(ui.backend.lastFrame).toContain('Moved 2 memories');
  expect(ui.backend.lastFrame).toContain('/memory');
  expect(existsSync(file)).toBe(false);
  expect(existsSync(`${file}.migrated`)).toBe(true);
  expect(factsUnder(join(dir, '_global')).sort()).toEqual(['Answers in Russian.', 'Prefers rebase over merge.']);
  // The note is the person's; the facts reach the model as the global index.
  await ui.type('hello');
  await ui.press('return');
  await settle(20);
  expect(JSON.stringify(model.requests.at(-1)!.messages)).not.toContain('Moved 2');
  expect(systemOf(model)).toContain('Prefers rebase over merge');
  ui.app.unmount();

  const again = new ScriptedModel();
  again.script([{ text: 'hi' }]);
  const ui2 = await bootApp(again, 110, 30, undefined, { workspace: { dir }, memory: { file } });
  await ui2.press('F');
  await settle(10);
  expect(ui2.backend.lastFrame).not.toContain('Moved');
  expect(factsUnder(join(dir, '_global'))).toHaveLength(2);
  ui2.app.unmount();
});
