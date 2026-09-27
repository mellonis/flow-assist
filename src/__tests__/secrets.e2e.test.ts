// A known secret through the real app: a tool that returns a configured token, and a
// model that repeats it — the model's next request, the frame, the session file and
// the journal all hold `‹secret NAME›`, never the value.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setActiveSecrets } from '../assistant/secrets.ts';
import type { Make } from '../loader/plugin.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { listTree } from './helpers/session-files';

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.e2e-wiki-token-body.signature-part';
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.WB_WIKI_TOKEN;
  setActiveSecrets(null);
});

const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

// A guest whose read tool answers with the environment it sees, token and all.
const wiki = (make: Make) => make('wiki', {
  tools: [{
    id: 'wiki',
    tools: [{ type: 'function', function: { name: 'wiki_env', description: 'Show the wiki settings.', parameters: { type: 'object', properties: {} } } }],
    exec: async () => `WB_WIKI_TOKEN=${process.env.WB_WIKI_TOKEN}`,
  }],
} as never);

test('a configured token a tool returns reaches the model, the screen, the session and the journal as ‹secret NAME›', async () => {
  process.env.WB_WIKI_TOKEN = TOKEN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-secrets-e2e-'));
  const model = new ScriptedModel();
  model.script(
    [{ text: 'Next: read the settings', tool: 'wiki_env', args: {} }],
    [{ text: `The token is ${TOKEN.slice(0, 20)}` }, { text: `${TOKEN.slice(20)} — done.` }],
  );
  const ui = await bootApp(model, 120, 30, (make) => [wiki(make)], { sessions: { dir } });
  await ui.press('F');
  await ui.type('why is the wiki missing?');
  await ui.press('return');
  await settleUntil(() => model.requests.length >= 2 && ui.backend.lastFrame.includes('done.'));
  // The session is saved a moment after the answer ends.
  await settleUntil(() => listTree(dir).some((n) => n.endsWith('.json')) && fs.readFileSync(path.join(dir, listTree(dir).find((n) => n.endsWith('.json'))!), 'utf8').includes('done.'));

  const request = JSON.stringify(model.requests[1]);
  expect(request).not.toContain(TOKEN);
  expect(request).toContain('WB_WIKI_TOKEN=‹secret WB_WIKI_TOKEN›');

  const frame = ui.backend.lastFrame;
  expect(frame).not.toContain(TOKEN.slice(0, 20));
  expect(frame).toContain('‹secret WB_WIKI_TOKEN›');

  const session = fs.readFileSync(path.join(dir, listTree(dir).find((n) => n.endsWith('.json'))!), 'utf8');
  expect(session).not.toContain(TOKEN);
  expect(session).toContain('‹secret WB_WIKI_TOKEN›');

  const journal = fs.readFileSync(path.join(dir, listTree(dir).find((n) => n.endsWith('.log.jsonl'))!), 'utf8');
  expect(journal).not.toContain(TOKEN);
  expect(journal).toContain('WB_WIKI_TOKEN=‹secret WB_WIKI_TOKEN›');
  expect(journal).toContain('The token is ‹secret WB_WIKI_TOKEN› — done.');
});

test('the person\'s own !command keeps the whole environment, and its output is still redacted', async () => {
  process.env.WB_WIKI_TOKEN = TOKEN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-secrets-e2e-'));
  const model = new ScriptedModel();
  const ui = await bootApp(model, 120, 30, undefined, { sessions: { dir } });
  await ui.press('F');
  await ui.type('!printf "seen:%s\\n" "$WB_WIKI_TOKEN"');
  await ui.press('return');
  await settleUntil(() => listTree(dir).some((n) => n.endsWith('.log.jsonl')) && fs.readFileSync(path.join(dir, listTree(dir).find((n) => n.endsWith('.log.jsonl'))!), 'utf8').includes('shell-end'));
  const journal = fs.readFileSync(path.join(dir, listTree(dir).find((n) => n.endsWith('.log.jsonl'))!), 'utf8');
  expect(journal).not.toContain(TOKEN);
  expect(journal).toContain('seen:‹secret WB_WIKI_TOKEN›');
});
