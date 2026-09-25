// The state of a remote plugin's stateful nodes — a field's text, a list's cursor, a
// checkbox, a ScrollBox offset — lives HERE, keyed by the node's `id`, so typing and
// the cursor never wait on the plugin. A `value` (`checked`, `offset`) prop in a frame
// is a WRITE — the plugin clearing a field, moving the cursor, replacing `hello` with
// `goodbye` — applied without asking. But a plugin that echoes the value from its own
// model sends frames that lag the typing (`h`, `he`, `hel` while the host holds
// `hello`), and applying those would clobber the input. So per id the host keeps a
// QUEUE of the last `ECHO_QUEUE` values it itself sent, oldest first, and a frame's
// value is checked against it in this order: found in the queue, it is an echo of
// that moment — the OLDEST matching entry and every entry before it drain, and the
// held value is left exactly as it is; not found there but equal to the HELD value,
// it is a no-op and the queue is left untouched; equal to neither, it is a write,
// applied at once, with the queue emptied. The queue is checked before the held value
// because equaling the held value is not proof the plugin caught up — it can just as
// well be the echo of an OLDER, still-outstanding moment: typing `h`, `he`, then
// backspacing back to `h` sends three frames, and the `h` that follows the backspace
// must not empty the queue, or the still-lagging `he` frame would land afterward as a
// write over the backspace. Draining on a match is what keeps a value the person
// revisits from poisoning the field forever; stopping the drain exactly at the oldest
// match leaves any newer, still-outstanding moment in the queue matchable in its own
// turn, as `he` stays matchable above. A deliberate write lands after at most as many
// frames as there are copies of its value already in the queue — bounded by
// `ECHO_QUEUE`, not by one, since each copy is read as its own echo in turn. An id
// absent from a whole frame loses its state. A frame's value prop may arrive as JSON
// `null` — a plugin in a language whose "nothing" serializes that way — and is read
// the same as the prop being absent: no value in the frame.
import type { Tree } from '@flow-assist/remote';
import { normalizeNode } from './frame.js';

export const ECHO_QUEUE = 32;
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
      const queue = sent.get(id) ?? [];
      queue.push(value);
      if (queue.length > ECHO_QUEUE) queue.shift();
      sent.set(id, queue);
    },
    applyFrame(surface, modals) {
      const seen = new Map<string, { prop: string; value: unknown; has: boolean }>();
      walk(surface, seen);
      for (const tree of Object.values(modals)) walk(tree, seen);
      for (const id of [...held.keys()]) if (!seen.has(id)) { held.delete(id); sent.delete(id); }
      for (const [id, { value, has }] of seen) {
        if (!has || value === undefined || value === null) continue;
        const queue = sent.get(id) ?? [];
        const idx = queue.findIndex((v) => same(v, value));
        if (idx !== -1) { sent.set(id, queue.slice(idx + 1)); continue; } // an echo: drop it and every older entry, held unchanged
        if (held.has(id) && same(held.get(id), value)) continue; // a no-op: equal to held, but not an echo the queue can vouch for — the queue stays as it is
        held.set(id, value);
        sent.delete(id);
      }
    },
  };
}
