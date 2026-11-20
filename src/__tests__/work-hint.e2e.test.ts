// The hint row's background badge: the `↓` work door with the number of rows it opens,
// and the subagents of this chat that wait on the person. The count is the door's while
// the door has work (a chat of resting children still has rows to show, and the
// registry-wide count would say 0), the registry-wide one otherwise; a waiting subagent
// adds `· N waiting` in the warn colour. The real app on the scripted model; the
// askClock rules of work-picker.e2e.test.ts apply — no pause is moved here, so the
// parked question has not taken the keys yet and `↓` is still the door's.
import { afterEach, expect, test } from 'bun:test';
import { askClock } from '../assistant/child-ask-guard.ts';
import { keyGlyph } from '../playback/keys.ts';
import { ScriptedModel, bootApp, firstUser, settle, type Turn } from './helpers/scripted';

const realFetch = globalThis.fetch;
const realNow = askClock.now;
const clock = { t: 10_000 };
afterEach(() => { globalThis.fetch = realFetch; askClock.now = realNow; });

const settleUntil = async (ok: () => boolean, n = 600) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const rowsOf = (ui: UI) => frameOf(ui).split('\n');
// The hint row: the one the history hint is on (attention.e2e.test.ts).
const hintRow = (frame: string, anchor = 'history · wheel') => frame.split('\n').find((r) => r.includes(anchor)) ?? '';
async function ask(ui: UI, text: string) { await ui.type(text); await ui.press('return'); }
// The work strip's own rows: inside its frame, from the tab row down to the frame's
// bottom border (work-picker.e2e.test.ts).
const PANEL = 'Flow Assist · Work';
const panelUp = (ui: UI) => frameOf(ui).includes(PANEL);
function stripText(ui: UI) {
  const rows = rowsOf(ui);
  const heading = rows.findIndex((r) => r.includes(PANEL));
  const end = rows.findIndex((r, i) => i > heading && r.trimStart().startsWith('╰'));
  return rows.slice(heading + 1, end > heading ? end : rows.length).join('\n');
}

// A subagent the person starts; its first step parks an `ask_parent` question, so it
// waits on the person once released.
const MARK = 'ASK';
async function boot() {
  clock.t = 10_000;
  askClock.now = () => clock.t;
  const model = new ScriptedModel();
  const child = model.when((req) => firstUser(req).includes(MARK));
  const script: Turn[] = [[{ hold: true }, { tool: 'ask_parent', args: { question: 'which one?' } }], [{ text: 'ask settled' }]];
  child.script(...script);
  const ui = await bootApp(model, 160, 34, undefined, {
    ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', backgroundFollowUp: false },
  }, { toastMs: 10_000 });
  return { ui, child };
}

test('the hint badge names the ↓ door and who waits, and the door opens on it', async () => {
  const { ui, child } = await boot();
  await ui.press('F');
  await ask(ui, `/subagent ${MARK} go`);
  await settleUntil(() => child.held);
  // The child is the door's one row, and it waits on nobody yet: the badge names the key
  // and counts the door's rows, not the registry-wide ones (there are none).
  expect(hintRow(frameOf(ui))).toContain(`${keyGlyph('down')} 1 in background`);
  expect(hintRow(frameOf(ui))).not.toContain('waiting');
  // Its question parks: the count stays the door's and the badge says who waits, in warn.
  child.release();
  await settleUntil(() => frameOf(ui).includes('from «ask-go»'));
  await settleUntil(() => hintRow(frameOf(ui)).includes('waiting'));
  expect(hintRow(frameOf(ui))).toContain(`${keyGlyph('down')} 1 in background · 1 waiting`);
  const hintAt = rowsOf(ui).findIndex((r) => r.includes('1 waiting'));
  const style = (ui.backend as unknown as { lastBuffer: { get(x: number, y: number): { style: { fg?: string; dim?: boolean } } } | null }).lastBuffer!
    .get(rowsOf(ui)[hintAt]!.indexOf('1 waiting'), hintAt).style;
  expect(style.fg).toBe('yellow');
  // ↓ before the question takes the keys: the door opens, on the row that waits.
  await ui.press('down');
  await settleUntil(() => panelUp(ui));
  expect(panelUp(ui)).toBe(true);
  expect(stripText(ui)).toContain('? waiting for you');
  // Esc closes the strip back to the chat; the hint is the chat's own again.
  await ui.press('escape');
  await settleUntil(() => !panelUp(ui));
  expect(panelUp(ui)).toBe(false);
  expect(hintRow(frameOf(ui))).toContain(`${keyGlyph('down')} 1 in background · 1 waiting`);
  ui.app.unmount();
}, 30_000);
