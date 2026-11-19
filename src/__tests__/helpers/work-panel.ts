// The work panel and the door it is: `↓` on an empty field opens the strip, and the
// tree rows under the field are entered from it — `⏎` watches the first subagent row and
// Esc steps back onto that row. The tests share this one route so a setup only ever
// enters the rows the way the app does.
import { bootApp, settle } from './scripted';

type UI = Awaited<ReturnType<typeof bootApp>>;
const frameOf = (ui: UI) => ui.backend.lastFrame ?? '';
const settleUntil = async (ok: () => boolean, n = 400) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

export const PANEL = 'Flow Assist · Work';
export const ROWS = '↑↓ move · x stop · Esc back';
const WATCH = '╭─ ƒ Flow Assist (scripted) · ';

// The cursor in the tree rows, on the first subagent's row: the panel is the door, and
// the watch's Esc is what puts the cursor on the row it was opened from.
export async function intoRows(ui: UI): Promise<void> {
  await ui.press('down');
  await settleUntil(() => frameOf(ui).includes(PANEL));
  await ui.press('return');
  await settleUntil(() => frameOf(ui).includes(WATCH));
  await ui.press('escape');
  await settleUntil(() => frameOf(ui).includes(ROWS));
}
