// The tree as flowtty elements: `toElement` turns one canvas node into what `ui.h`
// draws, recursing through the containers and building the composites (`progress`,
// `badge`, `rows`, `tasks`, `rule`) out of `Box` and `Text` lines. It reads a tree
// `checkTree` approved, so the props arrive in the vocabulary's names; what is
// sanitised here — a colour as a palette token, a bar that never leaves its width, a
// text cut to the pane — is the renderer's last line of defence, the way `parts`
// reads a broken value. A plugin's sources import nothing from the host: `TUi` is the
// shape of the `ui` it is handed, and the tests draw with a recording `h`.
//
// The interactive types (`input`, `check`, `select`, `button`) draw a static
// placeholder: one dim line naming the control and its bind. The surface task wires
// the values, the focus and the presses; nothing here keeps state or takes a handler.
import { bar, fit, percentText, taskGlyph, toneToken, type TTaskState } from './parts.ts';
import type { Node } from './tree.ts';

export type TUi = { h: (type: unknown, props?: Record<string, unknown>, ...children: unknown[]) => unknown; Box: unknown; Text: unknown; Markdown: unknown; Table: unknown; ScrollBox: unknown; Link: unknown };
export type TRenderCtx = { ui: TUi; width: number; stringWidth: (s: string) => number; focusKey: string | null; hasKeyboard: boolean; values: Record<string, string | boolean>; onValue: (bind: string, value: string | boolean) => void; onPress: (label: string, action: string) => void };

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

const BOX_PROPS = ['flexDirection', 'gap', 'padding', 'paddingX', 'paddingY', 'width', 'height', 'flexGrow', 'border', 'overflow', 'alignItems', 'justifyContent'];
const SCROLL_PROPS = ['height', 'flexGrow'];
const TABLE_PROPS = ['columns', 'rows', 'border', 'selectedIndex'];

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

// The Text props, sanitised: a colour is a palette token, the flags are booleans, and
// the vocabulary's `wrap: true` is flowtty's word wrap. `wrap: 'truncate'` and
// `truncate: true` are cut here with `fit` — only the renderer measures with the
// pane's `stringWidth` — so they contribute no wrap mode of their own.
const textProps = (props: TProps): TProps => {
  const out: TProps = {};
  if (props.color !== undefined) out.color = toneToken(props.color);
  if (props.bold === true) out.bold = true;
  if (props.dim === true) out.dim = true;
  if (props.wrap === true) out.wrap = 'wrap';
  return out;
};

// A control as one dim line until the surface wires it: the type, the bind its value
// lives under, its label, and the value the tree declares (or the placeholder).
const controlLine = (type: string, props: TProps): string => {
  const bind = str(props.bind);
  const label = str(props.label);
  const named = bind === '' ? '' : ` «${bind}»`;
  if (type === 'button') return `▸ button${label === '' ? '' : ` ${label}`}`;
  if (type === 'check') return `▸ check${named} ${props.value === true ? '[x]' : '[ ]'} ${label}`.trimEnd();
  const shown = str(props.value) !== '' ? str(props.value) : str(props.placeholder);
  return `▸ ${type}${named}${label === '' ? '' : ` ${label}`}${shown === '' ? '' : `: ${shown}`}`;
};

export function toElement(node: Node | string, ctx: TRenderCtx): unknown {
  const { ui } = ctx;
  const dimLine = (line: string): unknown => ui.h(ui.Text, { dim: true }, fit(line, ctx.width, ctx.stringWidth));

  const draw = (child: Node | string): unknown => {
    if (typeof child === 'string') return ui.h(ui.Text, {}, child);
    const { type, props, children } = readNode(child);
    switch (type) {
      // Containers keep their layout props and draw their children, which are nodes
      // here: the validator refuses a bare string inside a Box.
      case 'Box':
        return ui.h(ui.Box, only(props, BOX_PROPS), ...children.map(draw));
      case 'ScrollBox':
        return ui.h(ui.ScrollBox, only(props, SCROLL_PROPS), ...children.map(draw));
      case 'Text': {
        const truncate = props.truncate === true || props.wrap === 'truncate';
        const strings = children
          .filter((c): c is string => typeof c === 'string')
          .map((s) => (truncate ? fit(s, ctx.width, ctx.stringWidth) : s));
        return ui.h(ui.Text, textProps(props), ...strings);
      }
      case 'Markdown':
        return ui.h(ui.Markdown, {}, ...children.filter((c): c is string => typeof c === 'string'));
      // The table's props are the vocabulary's own — `columns` of `{ key, label }` and
      // `rows` of string arrays — passed through unchanged.
      case 'Table':
        return ui.h(ui.Table, only(props, TABLE_PROPS));
      case 'Link':
        return ui.h(ui.Link, { href: str(props.url) });
      // The composites: one line each, built from the pieces in `parts`. The outer
      // Box keeps a composite to one row of the column it sits in.
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
          ui.h(ui.Text, { color: toneToken(props.tone) }, bar(value, barWidth)),
          ui.h(ui.Text, { dim: true }, ` ${percent}`),
        ];
        return ui.h(ui.Box, {}, ui.h(ui.Box, { flexDirection: 'row' }, ...line));
      }
      case 'badge': {
        const tone = toneToken(props.tone);
        const line = fit(`${BADGE_GLYPH[tone] ?? BADGE_GLYPH_DEFAULT} ${str(props.text)}`, ctx.width, ctx.stringWidth);
        return ui.h(ui.Text, { color: tone, bold: true }, line);
      }
      case 'rows': {
        const items = itemsOf(props).map((item) => ({ label: str(item.label), value: str(item.value), tone: toneToken(item.tone) }));
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
          const glyph = ui.h(ui.Text, { color: TASK_TONE[item.state] ?? 'default' }, `${taskGlyph(item.state)} `);
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
      // The interactive types: a placeholder line, no state and no handler.
      case 'input':
      case 'check':
      case 'select':
      case 'button':
        return dimLine(controlLine(type, props));
      default:
        return dimLine(`▸ ${type}`);
    }
  };

  return draw(node);
}
