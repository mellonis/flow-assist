// A turn stopped at `ai.maxRounds` in the chat, when its last step carries a known secret
// across the 80-character cut: the step is redacted before it is cut, so the row, the
// journal and the host's line in the model's history carry the mark and no part of the
// secret.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJournal } from '../assistant/journal.ts';
import { activeSecrets, setActiveSecrets } from '../assistant/secrets.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { listTree } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const settleUntil = async (ok: () => boolean, n = 300) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type Msg = { role: string; content: unknown };

const SECRET = 'roundcap-secret-7777-value';
const MARK = '‹secret FA_ROUNDCAP_API_TOKEN›';
// Part of what the cut would leave of the secret were it redacted after the cut.
const FRAGMENT = SECRET.slice(0, 8);

test('a last step whose secret crosses the cut reaches the row, the journal and the model only as its mark', async () => {
  const before = activeSecrets();
  process.env.FA_ROUNDCAP_API_TOKEN = SECRET;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-roundcap-secret-'));
    const pad = 'z'.repeat(52);
    const model = new ScriptedModel();
    // `datetime {"zone":"` is 18 characters; 52 more put the secret across the cut at 80.
    model.script([{ tool: 'datetime', args: {} }], [{ tool: 'datetime', args: { zone: `${pad}${SECRET}` } }], [{ text: 'Done now.' }]);
    const ui = await bootApp(model, 200, 30, undefined, { sessions: { dir }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', maxRounds: 2 } });
    await ui.press('F');
    await ui.type('work for a while');
    await ui.press('return');
    await settleUntil(() => ui.backend.lastFrame.includes('stopped after'));
    await settle(8);
    expect(model.requests).toHaveLength(2);
    // The row (`roundLimitAt`), as the chat draws it.
    const frame = ui.backend.lastFrame;
    expect(frame).toContain(`last: datetime {"zone":"${pad}‹secret`);
    expect(frame).not.toContain(FRAGMENT);
    // The journal's end line.
    const journal = listTree(dir).find((n) => n.endsWith('.log.jsonl'))!;
    const end = readJournal(path.join(dir, journal))!.find((e) => e.t === 'end')!;
    expect(String(end.lastStep)).toStartWith(`datetime {"zone":"${pad}‹secret`);
    expect(JSON.stringify(end)).not.toContain(FRAGMENT);
    // The host's line in the model's history, sent with `continue`.
    await ui.press('return');
    await settleUntil(() => ui.backend.lastFrame.includes('Done now.'));
    const sent = (model.requests[2] as { messages: Msg[] }).messages;
    const line = String(sent.at(-2)!.content);
    expect(line).toContain(`my last step was datetime {"zone":"${pad}‹secret`);
    expect(line).not.toContain(FRAGMENT);
    ui.app.unmount();
  } finally {
    delete process.env.FA_ROUNDCAP_API_TOKEN;
    setActiveSecrets(before);
  }
});
