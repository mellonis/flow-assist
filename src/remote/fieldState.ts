// The state of a remote plugin's stateful nodes — a field's text, a list's cursor, a
// checkbox, a ScrollBox offset — lives HERE, keyed by the node's `id`, so typing and
// the cursor never wait on the plugin. A `value` (`checked`, `offset`) prop in a frame
// is a WRITE — the plugin clearing a field, moving the cursor, replacing `hello` with
// `goodbye` — applied without asking. But a plugin that echoes the value from its own
// model sends frames that lag the typing (`h`, `he`, `hel` while the host holds
// `hello`), and applying those would clobber the input. So per id the last
// `ECHO_RING` values the host itself sent in `changed` are kept: a frame's value equal
// to any of them is an echo and is ignored; one equal to none is applied and the ring
// is cleared. An id absent from a whole frame loses its state. A frame's value prop
// may arrive as JSON `null` — a plugin in a language whose "nothing" serializes that
// way — and is read the same as the prop being absent: no value in the frame.
import type { Tree } from '@flow-assist/remote';
import { normalizeNode } from './frame.js';

export const ECHO_RING = 32;
const VALUE_PROP: Record<string, string> = { TextInput: 'value', Select: 'value', ListSelect: 'value', ListMultiSelect: 'value', Checkbox: 'checked', ScrollBox: 'offset' };

const same = (a: unknown, b: unknown): boolean => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

export interface FieldState {
  get(id: string): unknown;
  set(id: string, value: unknown): void;
  applyFrame(surface: Tree | null, modals: Record<string, Tree | null>): void;
}

export function createFieldState(): FieldState {
  const held = new Map<string, unknown>();
  const sent = new Map<string, unknown[]>();
  const walk = (t: unknown, seen: Map<string, { prop: string; value: unknown; has: boolean }>) => {
    const node = normalizeNode(t);
    if (!node) return;
    const prop = VALUE_PROP[node.type];
    const id = node.props.id;
    if (prop && typeof id === 'string' && id) seen.set(id, { prop, value: node.props[prop], has: prop in node.props });
    for (const c of node.children) if (typeof c !== 'string') walk(c, seen);
  };
  return {
    get: (id) => held.get(id),
    set(id, value) {
      held.set(id, value);
      const ring = sent.get(id) ?? [];
      ring.push(value);
      if (ring.length > ECHO_RING) ring.shift();
      sent.set(id, ring);
    },
    applyFrame(surface, modals) {
      const seen = new Map<string, { prop: string; value: unknown; has: boolean }>();
      walk(surface, seen);
      for (const tree of Object.values(modals)) walk(tree, seen);
      for (const id of [...held.keys()]) if (!seen.has(id)) { held.delete(id); sent.delete(id); }
      for (const [id, { value, has }] of seen) {
        if (!has || value === undefined || value === null) continue;
        if (held.has(id) && same(held.get(id), value)) continue;
        if ((sent.get(id) ?? []).some((v) => same(v, value))) continue; // an echo
        held.set(id, value);
        sent.delete(id);
      }
    },
  };
}
