// The work strip, the one place for the session's background work: `↓` on an empty field
// opens it, `⏎` opens (watches) the row under the cursor and Esc closes it. The tests share
// these helpers so each reaches the strip the way the app does.
import { bootApp, settle } from './scripted';

type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const rowsOf = (ui: UI) => frameOf(ui).split('\n');
const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

export const PANEL = 'Flow Assist · Work';
export const stripUp = (ui: UI) => frameOf(ui).includes(PANEL);

// `↓` on an empty field opens the strip on its first row.
export async function openStrip(ui: UI): Promise<void> {
  await ui.press('down');
  await settleUntil(() => stripUp(ui));
}

// Esc closes the strip; the field has the keys again.
export async function closeStrip(ui: UI): Promise<void> {
  await ui.press('escape');
  await settleUntil(() => !stripUp(ui));
}

// The strip's own lines — from its heading down to the frame's bottom border — without
// opening or closing it. The chat above says the same labels (`subagent «hyn-go» started`),
// so a frame-wide read would pass on a chat line instead.
export function stripRows(ui: UI): string[] {
  const rows = rowsOf(ui);
  const top = rows.findIndex((r) => r.includes(PANEL));
  if (top < 0) return [];
  const bottom = rows.findIndex((r, i) => i > top && r.includes('╰'));
  return rows.slice(top + 1, bottom > top ? bottom : rows.length);
}

// A live node's row as the strip words it now — its label and its state — or '' when the
// door opened nothing (an ended node is `/agents`' to show). The field has the keys again
// on the way out.
export async function stripRow(ui: UI, label: string): Promise<string> {
  await openStrip(ui);
  const row = stripRows(ui).find((r) => r.includes(label)) ?? '';
  await closeStrip(ui);
  return row;
}
