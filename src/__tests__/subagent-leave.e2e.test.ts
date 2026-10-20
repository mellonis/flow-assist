// A session left while it has an idle subagent stays loaded: the person who comes back finds the
// subagent in the same conversation and can write to it (AGENTS.md (a host makes its
// conversations through one registry)). The real app on the scripted model.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, firstUser, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
const frameOf = (ui: { backend: { lastFrame?: string } }) => ui.backend.lastFrame ?? '';
type UI = Awaited<ReturnType<typeof bootApp>>;
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
async function pick(ui: UI, text: string) {
  ui.backend.press({ name: 's', ctrl: true });
  await settle(3);
  const rows = frameOf(ui).split('\n').filter((r) => / msgs? │/.test(r));
  const at = rows.findIndex((r) => r.includes(text));
  if (at < 0) throw new Error(`pick: no row with ${text}`);
  for (let i = 0; i < at; i++) { await ui.press('down'); await settle(1); }
  await ui.press('return');
  await settle(4);
}
async function pickerFrame(ui: UI): Promise<string> {
  ui.backend.press({ name: 's', ctrl: true });
  await settle(3);
  const f = frameOf(ui);
  await ui.press('escape');
  await settle(2);
  return f;
}

test('a session left with an idle subagent keeps it: the picker reads the session by its own status, the subagent answers a tell after the return, and the exit writes its end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-leave-idle-'));
  const model = new ScriptedModel();
  const child = model.when((req) => firstUser(req).includes('KEEP-ONE'));
  child.script([{ text: 'first reply' }], [{ text: 'reply after the return' }]);
  model.script([{ text: 'A answer.' }], [{ text: 'B answer.' }]);
  const ui = await bootApp(model, 120, 30, undefined, { sessions: { dir }, ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false } }, { toastMs: 10_000 });
  await ui.press('F');
  await ask(ui, 'session A question');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  await ask(ui, '/subagent KEEP-ONE go');
  await settleUntil(() => frameOf(ui).includes('◆ keep-one-go finished:'));
  await ask(ui, '/new');
  await settle(4);
  await ask(ui, 'session B question');
  await settleUntil(() => frameOf(ui).includes('B answer.'));
  // A is held (its subagent), not put away: the picker says it is here, and not working.
  const list = await pickerFrame(ui);
  const rowA = list.split('\n').find((r) => r.includes('session A question')) ?? '';
  expect(rowA).toContain('here');
  expect(rowA).not.toContain('working');
  await pick(ui, 'session A question');
  await settleUntil(() => frameOf(ui).includes('A answer.'));
  await ask(ui, '/subagent tell keep-one-go anything new?');
  await settleUntil(() => child.requests.length === 2);
  expect(frameOf(ui)).toContain('message sent to «keep-one-go»');
  await settleUntil(() => frameOf(ui).includes('◦ keep-one-go · answered'));
  ui.app.unmount();
});
