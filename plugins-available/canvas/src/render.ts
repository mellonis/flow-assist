// The tree as flowtty elements: `toElement` turns one canvas node into what `ui.h`
// draws, recursing through the containers and building the composites (`progress`,
// `badge`, `rows`, `tasks`, `rule`) out of `Box` and `Text` lines. It reads a tree
// `checkTree` approved, so the props arrive in the vocabulary's names; what is
// sanitised here — a colour as a palette token, a bar that never leaves its width, a
// text cut to the pane — is the renderer's last line of defence, the way `parts`
// reads a broken value. A plugin's sources import nothing from the host: `TUi` is the
// shape of the `ui` it is handed, and the tests draw with a recording `h`.
//
// The interactive types (`input`, `check`, `select`, `button`) are live controls: a
// field takes its value from the canvas's map and reports edits through `ctx.onValue`,
// a button presses through `ctx.onPress`, and a control is focused only while the
// canvas holds the keys and carries its focus key. The renderer keeps nothing between
// calls — the surface owns the values and the focus — and numbers buttons in draw order
// only so a focused button can mark itself.
import { bar, fit, percentText, taskGlyph, toneToken, type TTaskState } from './parts.ts';
import { buttonKey } from './focus.ts';
import type { Node } from './tree.ts';
import type { TValue } from './store.ts';

export type TUi = { h: (type: unknown, props?: Record<string, unknown>, ...children: unknown[]) => unknown; Box: unknown; Text: unknown; Markdown: unknown; Table: unknown; ScrollBox: unknown; Link: unknown; TextInput: unknown; Checkbox: unknown; Select: unknown };
export type TRenderCtx = { ui: TUi; width: number; stringWidth: (s: string) => number; focusKey: string | null; hasKeyboard: boolean; values: Record<string, TValue>; onValue: (bind: string, value: TValue) => void; onPress: (label: string, action: string) => void; colors?: Record<string, string> };

// The plugin's palette: the vocabulary's tones as the named colours flowtty paints in
// (its own `Color` is a named colour or a literal, so a token like `ok` would be
// dropped as an unknown name and paint nothing). `make('canvas', { colors })` hands
// this map to the host theme, where it lands as `theme.canvas` with the person's
// `config.plugins.canvas.colors` laid over it; the surface passes that resolved map in
// as `ctx.colors`, and `default` is what a tone with no colour of its own gets.
export const TOKEN_COLOR: Record<string, string> = { ok: 'green', warn: 'yellow', error: 'red', accent: 'cyan', dim: 'gray', muted: 'gray', default: 'default' };

type TProps = Record<string, unknown>;

// A progress line: the label, a bar of 3–20 cells, the percentage. The slack covers
// the two spaces between them and the pane's own padding, so the line fits a pane of
// `width` cells; the bar keeps its 3 cells even when the pane cannot hold the rest.
const BAR_MIN = 3;
const BAR_MAX = 20;
const BAR_SLACK = 8;

// The colour a task state draws its glyph in.
const TASK_TONE: Record<TTaskState, string> = { done: 'ok', running: 'accent', queued: 'dim', failed: 'error' };

// The glyph a badge leads with: its tone says whether the line is a pass, a warning
// or a failure; a tone that names none of them reads as a plain mark.
const BADGE_GLYPH: Record<string, string> = { ok: '●', warn: '▲', error: '✗' };
const BADGE_GLYPH_DEFAULT = '●';

const BOX_PROPS = ['flexDirection', 'gap', 'padding', 'paddingX', 'paddingY', 'width', 'height', 'flexGrow', 'overflow', 'alignItems', 'justifyContent'];
const SCROLL_PROPS = ['height', 'flexGrow'];

const isPlainObject = (v: unknown): v is TProps => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// The props this renderer forwards, and only those: an absent one stays absent, so
// the component's own default applies instead of an explicit `undefined`.
const only = (props: TProps, keys: string[]): TProps => {
  const out: TProps = {};
  for (const key of keys) if (props[key] !== undefined) out[key] = props[key];
  return out;
};

// A node read the way the host reads one: the second element is the props only when
// it is a plain object, so `['Text', 'hi']` is a Text with a string child.
const readNode = (node: Node): { type: string; props: TProps; children: Array<Node | string> } => {
  const second = node[1];
  const hasProps = isPlainObject(second);
  const rest = (hasProps ? node.slice(2) : node.slice(1)) as unknown[];
  const children = rest.filter((c): c is Node | string => typeof c === 'string' || Array.isArray(c)) as Array<Node | string>;
  return { type: str(node[0]), props: hasProps ? second : {}, children };
};

// The item arrays of `rows` and `tasks`: the validator caps them at 100 and refuses a
// broken shape, so a non-object here is dropped rather than drawn as a blank line.
const itemsOf = (props: TProps): TProps[] => (Array.isArray(props.items) ? props.items : []).filter(isPlainObject);

// A select's options as flowtty's items: the vocabulary's `{ value, label }` is
// already that shape, so the broken entries are dropped and the rest normalised.
const selectItems = (props: TProps): Array<{ value: string; label: string }> => {
  const options = Array.isArray(props.options) ? props.options : [];
  return options.filter(isPlainObject).map((option) => ({ value: str(option.value), label: str(option.label) }));
};

// A select's declared value: the `value` prop, else the first option's — the same
// choice `store` makes when it seeds the canvas's map.
const selectValue = (props: TProps, items: Array<{ value: string }>): string => {
  const named = str(props.value);
  return named !== '' ? named : items[0]?.value ?? '';
};

// The Text props, sanitised: a colour is a palette token painted through `paint`, the
// flags are booleans, and `wrap` is flowtty's word wrap. `truncate` is cut here with
// `fit` — only the renderer measures with the pane's `stringWidth` — so it contributes
// no wrap mode of its own.
const textProps = (props: TProps, paint: (tone: unknown) => string): TProps => {
  const out: TProps = {};
  if (props.color !== undefined) out.color = paint(props.color);
  if (props.bold === true) out.bold = true;
  if (props.dim === true) out.dim = true;
  if (props.wrap === true) out.wrap = 'wrap';
  return out;
};

// flowtty's borders are styles, the vocabulary's are a flag: `true` is the round border
// the host's own panels draw, `false` is no border — omitted for a Box, which has none
// by default, and `'none'` for a Table, whose grid takes an explicit "no border".
const borderOf = (border: unknown, off: string | undefined): string | undefined =>
  border === true ? 'round' : border === false ? off : undefined;

// A Box's layout props, with the border flag mapped to a style it accepts: passed on
// as a boolean, flowtty indexes its glyph set by it and throws.
const boxProps = (props: TProps): TProps => {
  const out = only(props, BOX_PROPS);
  const border = borderOf(props.border, undefined);
  if (border !== undefined) out.border = border;
  return out;
};

// A Table adapted to flowtty's own props: `rows` of strings become one record per row
// keyed by the column `key` (a row with fewer cells is padded with `''`), and the
// vocabulary's `{ key, label, width? }` becomes `{ accessor, header, width? }`.
const tableProps = (props: TProps): TProps => {
  const columns = (Array.isArray(props.columns) ? props.columns : []).filter(isPlainObject);
  const rows = (Array.isArray(props.rows) ? props.rows : []).filter(Array.isArray);
  const keys = columns.map((column) => str(column.key));
  const data = rows.map((row) => {
    const record: TProps = {};
    keys.forEach((key, index) => {
      const cell = row[index];
      record[key] = typeof cell === 'string' ? cell : '';
    });
    return record;
  });
  const adapted = columns.map((column) => {
    const width = column.width === undefined ? {} : { width: column.width };
    return { accessor: str(column.key), header: str(column.label), ...width };
  });
  const out: TProps = { data, columns: adapted };
  const border = borderOf(props.border, 'none');
  if (border !== undefined) out.border = border;
  if (props.selectedIndex !== undefined) out.selectedIndex = props.selectedIndex;
  return out;
};

// The width an input takes when the tree names none: enough for a branch name and
// still narrow enough to sit beside a checkbox and a button in a row.
const FIELD_WIDTH = 24;

export function toElement(node: Node | string, ctx: TRenderCtx): unknown {
  const { ui } = ctx;
  // The palette the surface hands in, else the plugin's own: a tone is a token first
  // and a flowtty colour after that, and a token the palette does not name paints as
  // the terminal's default.
  const colors = ctx.colors ?? TOKEN_COLOR;
  const paint = (tone: unknown): string => colors[toneToken(tone)] ?? TOKEN_COLOR.default;
  const dimLine = (line: string): unknown => ui.h(ui.Text, { dim: true }, fit(line, ctx.width, ctx.stringWidth));
  // A control takes the focus only while the canvas holds the keys: a canvas drawn
  // beside the chat never pulls the caret away from the prompt.
  const focused = (key: string): boolean => ctx.hasKeyboard && ctx.focusKey === key;
  // Buttons are numbered in draw order, the order `focus.ts` counts them in, so a button
  // knows its own focus key and can mark itself. `draw` descends through the children in
  // tree order, and a validated tree nests them only in a Box or a ScrollBox.
  let buttons = 0;

  const draw = (child: Node | string): unknown => {
    if (typeof child === 'string') return ui.h(ui.Text, {}, child);
    const { type, props, children } = readNode(child);
    switch (type) {
      // Containers keep their layout props and draw their children, which are nodes
      // here: the validator refuses a bare string inside a Box.
      case 'Box':
        return ui.h(ui.Box, boxProps(props), ...children.map(draw));
      case 'ScrollBox':
        return ui.h(ui.ScrollBox, only(props, SCROLL_PROPS), ...children.map(draw));
      case 'Text': {
        const truncate = props.truncate === true;
        const strings = children
          .filter((c): c is string => typeof c === 'string')
          .map((s) => (truncate ? fit(s, ctx.width, ctx.stringWidth) : s));
        return ui.h(ui.Text, textProps(props, paint), ...strings);
      }
      case 'Markdown':
        return ui.h(ui.Markdown, {}, ...children.filter((c): c is string => typeof c === 'string'));
      // The vocabulary's `columns`/`rows` are adapted to the props flowtty's Table
      // reads; passed on raw, its first `data.length` throws.
      case 'Table':
        return ui.h(ui.Table, tableProps(props));
      case 'Link':
        return ui.h(ui.Link, { href: str(props.url) });
      // The composites: one line each, built from the pieces in `parts`. A composite is
      // a Box holding its line as the one child — the shape the brief's tests read —
      // and the line is a row of Texts.
      case 'progress': {
        const value = typeof props.value === 'number' ? props.value : 0;
        const percent = percentText(value);
        const label = str(props.label);
        const barWidth = Math.max(BAR_MIN, Math.min(BAR_MAX, ctx.width - ctx.stringWidth(label) - BAR_SLACK));
        // The label takes what the bar, the two spaces and the percentage leave; on a
        // pane too narrow for it, it is cut rather than pushing the bar off the line.
        const labelRoom = Math.max(0, ctx.width - barWidth - 2 - ctx.stringWidth(percent));
        const cut = fit(label, labelRoom, ctx.stringWidth);
        const line = [
          ...(cut === '' ? [] : [ui.h(ui.Text, { dim: true }, `${cut} `)]),
          ui.h(ui.Text, { color: paint(props.tone) }, bar(value, barWidth)),
          ui.h(ui.Text, { dim: true }, ` ${percent}`),
        ];
        return ui.h(ui.Box, {}, ui.h(ui.Box, { flexDirection: 'row' }, ...line));
      }
      case 'badge': {
        const token = toneToken(props.tone);
        const line = fit(`${BADGE_GLYPH[token] ?? BADGE_GLYPH_DEFAULT} ${str(props.text)}`, ctx.width, ctx.stringWidth);
        return ui.h(ui.Text, { color: paint(token), bold: true }, line);
      }
      case 'rows': {
        const items = itemsOf(props).map((item) => ({ label: str(item.label), value: str(item.value), tone: paint(item.tone) }));
        // The labels share one column, half the pane at most, so the values line up
        // under each other; a value takes the rest of the line.
        const widest = items.reduce((n, item) => Math.max(n, ctx.stringWidth(item.label)), 0);
        const labelWidth = Math.min(widest, Math.max(0, Math.floor(ctx.width / 2) - 2));
        const valueWidth = Math.max(0, ctx.width - labelWidth - 2);
        const lines = items.map((item) => {
          const label = fit(item.label, labelWidth, ctx.stringWidth);
          const pad = ' '.repeat(Math.max(0, labelWidth - ctx.stringWidth(label)) + 2);
          return ui.h(ui.Box, { flexDirection: 'row' },
            ui.h(ui.Text, { dim: true }, `${label}${pad}`),
            ui.h(ui.Text, { color: item.tone }, fit(item.value, valueWidth, ctx.stringWidth)));
        });
        return ui.h(ui.Box, { flexDirection: 'column' }, ...lines);
      }
      case 'tasks': {
        const items = itemsOf(props).map((item) => ({ text: str(item.text), state: item.state as TTaskState }));
        const textWidth = Math.max(0, ctx.width - 2);
        const lines = items.map((item) => {
          const glyph = ui.h(ui.Text, { color: paint(TASK_TONE[item.state] ?? 'default') }, `${taskGlyph(item.state)} `);
          return ui.h(ui.Box, { flexDirection: 'row' }, glyph, ui.h(ui.Text, {}, fit(item.text, textWidth, ctx.stringWidth)));
        });
        return ui.h(ui.Box, { flexDirection: 'column' }, ...lines);
      }
      case 'rule': {
        const width = Math.max(1, Math.floor(ctx.width));
        const label = str(props.label);
        const head = label === '' ? '' : `─ ${fit(label, Math.max(0, width - 4), ctx.stringWidth)} `;
        return ui.h(ui.Text, { dim: true }, `${head}${'─'.repeat(Math.max(0, width - ctx.stringWidth(head)))}`);
      }
      // The interactive types: a live control. Its value is the canvas's, which
      // `drawCanvas` seeds with every bind; the tree's declared value is the fallback
      // for a tree drawn straight through `toElement` (a unit test), where the map may
      // be empty. A control is focused only while the canvas holds the keys and
      // carries this node's focus key — a canvas without the keyboard never steals a
      // caret, and the same focus key the surface's Tab cycle hands out is what draws
      // the focus (see `focus.ts`).
      case 'input': {
        const bind = str(props.bind);
        const live = ctx.values[bind];
        return ui.h(ui.TextInput, {
          frame: 'field',
          width: props.width ?? FIELD_WIDTH,
          value: typeof live === 'string' ? live : str(props.value),
          onChange: (next: string) => ctx.onValue(bind, next),
          isFocused: focused(bind),
        });
      }
      case 'check': {
        const bind = str(props.bind);
        const live = ctx.values[bind];
        return ui.h(ui.Checkbox, {
          checked: typeof live === 'boolean' ? live : props.value === true,
          label: str(props.label),
          onChange: (next: boolean) => ctx.onValue(bind, next),
          isFocused: focused(bind),
        });
      }
      case 'select': {
        const bind = str(props.bind);
        const live = ctx.values[bind];
        const items = selectItems(props);
        const chosen = typeof live === 'string' ? live : selectValue(props, items);
        // An empty choice is flowtty's "nothing chosen", which draws the placeholder
        // rather than an empty field.
        return ui.h(ui.Select, {
          items,
          value: chosen === '' ? undefined : chosen,
          onChange: (next: string) => ctx.onValue(bind, next),
          isFocused: focused(bind),
        });
      }
      // A button draws as bold text in its tone, inverse while it holds the focus — the
      // marker this repo already draws for a pressable Text. A click presses through the
      // same `ctx.onPress` the keyboard path calls with the focus key's action.
      case 'button': {
        const label = str(props.label);
        const style: TProps = { bold: true, color: paint(props.tone), selectable: false, onClick: () => ctx.onPress(label, str(props.action)) };
        if (focused(buttonKey(buttons))) style.inverse = true;
        buttons += 1;
        return ui.h(ui.Text, style, label);
      }
      default:
        return dimLine(`▸ ${type}`);
    }
  };

  return draw(node);
}
