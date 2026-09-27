// A plugin command's panel in the chat: `/mcp` lists the servers in the conversation's
// place, as the session picker lists the sessions, with the plugin's own keys for what
// can be done to the row under the cursor (docs/plugins.md, "Commands, keys and the
// footer"). Pure state and what a key does; the chat owns the state and the render
// (`renderCommandPanel`, src/views/modals.ts) draws it.
//
// The rows are the plugin's and read at every draw (`rows()`), so a panel follows what
// changes under it — a server that connects while the list is up. A key's `run` may
// answer a line for the panel's notice, or a panel of its own, which is opened over this
// one: Esc goes back to the one before it, and closes the last.

export type PanelRow = {
  // What the key's `run` is handed for the row under the cursor.
  id: string;
  text: string;
  // Said dim after the text; it gives way first when the row is cut.
  detail?: string;
  // How the detail is coloured: `ok` a good state, `warn` one to look at, `error` one
  // that failed; none — dim.
  tone?: 'ok' | 'warn' | 'error';
};

export type PanelKeyDef = {
  // The key as the terminal names it (`d`, `r`, `return`) — a key the panel does not
  // take for itself (`up`, `down`, `escape`).
  key: string;
  label: string;
  // Runs on the row under the cursor (null — the panel has no rows). May answer a line
  // for the notice, a panel to open over this one, or a promise of either.
  run: (id: string | null) => unknown;
};

export type PanelSpec = {
  title: string;
  rows: () => PanelRow[];
  keys?: PanelKeyDef[];
  // What the panel says when it has no rows.
  empty?: string;
};

export type PanelState = { stack: PanelSpec[]; cursor: number; notice: string };

// The keys the panel keeps for itself; a plugin's key of the same name is never run.
export const PANEL_OWN_KEYS = ['up', 'down', 'escape'];

export const panelStart = (spec: PanelSpec): PanelState => ({ stack: [spec], cursor: 0, notice: '' });

export const panelTop = (state: PanelState): PanelSpec => state.stack[state.stack.length - 1]!;

// The top panel's rows as the plugin gives them now; a throw is no rows and says why.
export function panelRows(state: PanelState): { rows: PanelRow[]; error?: string } {
  try {
    const rows = panelTop(state).rows();
    return { rows: Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === 'string') : [] };
  } catch (e) {
    return { rows: [], error: (e as Error).message };
  }
}

// The keys the top panel offers, the panel's own left out.
export const panelKeys = (state: PanelState): PanelKeyDef[] =>
  (panelTop(state).keys ?? []).filter((k) => k && typeof k.key === 'string' && !PANEL_OWN_KEYS.includes(k.key) && typeof k.run === 'function');

export type PanelStep = { state: PanelState | null; run?: { def: PanelKeyDef; id: string | null } };

type Key = { name?: string; ctrl?: boolean; meta?: boolean };

// A key while the panel is up. `state: null` — the panel closed. The cursor is kept in
// the rows there are now: they may have changed since it moved.
export function panelKey(state: PanelState, key: Key): PanelStep {
  const { rows } = panelRows(state);
  const last = Math.max(0, rows.length - 1);
  const cursor = Math.min(state.cursor, last);
  if (key.name === 'escape') {
    return { state: state.stack.length > 1 ? { stack: state.stack.slice(0, -1), cursor: 0, notice: '' } : null };
  }
  if (key.name === 'up') return { state: { ...state, cursor: Math.max(0, cursor - 1) } };
  if (key.name === 'down') return { state: { ...state, cursor: Math.min(last, cursor + 1) } };
  if (key.ctrl || key.meta) return { state };
  const def = panelKeys(state).find((k) => k.key === key.name);
  if (!def) return { state };
  return { state: { ...state, cursor, notice: '' }, run: { def, id: rows[cursor]?.id ?? null } };
}

const isSpec = (v: unknown): v is PanelSpec => !!v && typeof v === 'object' && typeof (v as PanelSpec).rows === 'function' && typeof (v as PanelSpec).title === 'string';

// What a key's `run` answered, laid on the panel it ran in: a panel opens over it, a line
// is its notice, anything else leaves it as it is.
export function panelAnswer(state: PanelState, answer: unknown): PanelState {
  if (isSpec(answer)) return { stack: [...state.stack, answer], cursor: 0, notice: '' };
  if (typeof answer === 'string' && answer) return { ...state, notice: answer };
  return state;
}

export { isSpec as isPanelSpec };
