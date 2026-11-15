// The focus model: one key per interactive node, in tree order — a field's bind, and
// `btn:<n>` for a button, `n` its index among the buttons alone, so the keyboard path
// and the renderer's `onClick` agree on which button a key names. Tab walks the keys
// and wraps at both ends; a key names a press only when it is a button. Nothing here
// draws, and nothing here imports the renderer, so a surface can ask for keys without
// touching `toElement`.
import type { Node } from './tree.ts';

const FIELDS = new Set(['input', 'check', 'select']);

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// A node's parts, read as `checkTree` reads them: the second element is the props only
// when it is a plain object, and the rest are the children.
const partsOf = (node: unknown[]): { type: string; props: Record<string, unknown>; children: unknown[] } => {
  const second = node[1];
  const hasProps = isPlainObject(second);
  return { type: str(node[0]), props: hasProps ? second : {}, children: hasProps ? node.slice(2) : node.slice(1) };
};

const buttonKey = (index: number): string => `btn:${index}`;

// Every focus key of a tree, depth-first: a field contributes its bind, a button its
// `btn:<n>`. A field with no bind and a string child contribute nothing.
export function focusKeys(node: Node | string): string[] {
  const keys: string[] = [];
  let buttons = 0;
  const walk = (n: unknown): void => {
    if (!Array.isArray(n)) return;
    const { type, props, children } = partsOf(n);
    if (FIELDS.has(type)) {
      const bind = str(props.bind);
      if (bind !== '') keys.push(bind);
    } else if (type === 'button') {
      keys.push(buttonKey(buttons));
      buttons += 1;
    }
    for (const child of children) walk(child);
  };
  walk(node);
  return keys;
}

// Tab: the next key, wrapping at both ends. A canvas with no interactive node keeps
// nothing focused; a current key the tree no longer carries enters at the near end, so
// the first Tab lands on the first field and the first Shift-Tab on the last.
export function nextKey(keys: string[], current: string | null, step: 1 | -1): string | null {
  if (keys.length === 0) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  if (at === -1) return step === 1 ? keys[0] ?? null : keys[keys.length - 1] ?? null;
  return keys[(at + step + keys.length) % keys.length] ?? null;
}

// What a focus key presses: a button's label and action. A field takes an edit rather
// than a press, and a key naming no node presses nothing — both are null.
export function actionOf(node: Node | string, key: string): { label: string; action: string } | null {
  let buttons = 0;
  let found: { label: string; action: string } | null = null;
  const walk = (n: unknown): void => {
    if (found !== null || !Array.isArray(n)) return;
    const { type, props, children } = partsOf(n);
    if (type === 'button') {
      const index = buttons;
      buttons += 1;
      if (buttonKey(index) === key) found = { label: str(props.label), action: str(props.action) };
    }
    for (const child of children) walk(child);
  };
  walk(node);
  return found;
}
