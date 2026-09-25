// Which keys a remote plugin takes, and what it is told about one. `consume` in a frame
// is written the way a person writes a binding (`enter`, `esc`, `ctrl+r`) and
// canonicalised once per frame with the host's own `canonicalBinding`, so the plugin
// never learns that the terminal says `return`. The event it gets carries all three
// names: the terminal's, the canonical id bindings are compared by, and the action
// from `hello.keys` the key resolves to under the person's `config.keys`.
import { canonicalBinding, isMouseButton, isPrintableKey, keyId } from '../playback/keys.js';
import type { ConsumeSpec, KeyEvent } from '@flow-assist/remote';

export interface InputKey { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean }
export type Consume = { all: true } | { all: false; ids: Set<string>; printable: boolean };

export function canonicalConsume(spec: ConsumeSpec): Consume {
  if (spec === '*') return { all: true };
  const ids = new Set<string>();
  let printable = false;
  for (const s of spec) {
    if (s === 'printable') { printable = true; continue; }
    for (const id of canonicalBinding(s)) ids.add(id);
  }
  return { all: false, ids, printable };
}

// The mouse — buttons and the wheel — is never a plugin's to take: it drives the
// host's drag-selection and scrolling, whatever `consume` says.
export function consumes(c: Consume, key: InputKey): boolean {
  if (isMouseButton(key.name) || key.name.startsWith('wheel')) return false;
  if (c.all) return true;
  if (c.ids.has(keyId(key))) return true;
  return c.printable && isPrintableKey(key);
}

// `keys` is the resolved binding map narrowed to the plugin's own actions, so a key the
// host binds too (`down` is the host's `next`) never names the host's action.
export function keyEventFor(key: InputKey, keys: Record<string, string[]>): KeyEvent {
  const id = keyId(key);
  const ev: KeyEvent = { name: key.name, id };
  if (key.ctrl) ev.ctrl = true;
  if (key.meta) ev.meta = true;
  if (key.shift) ev.shift = true;
  const action = Object.entries(keys).find(([, bindings]) => bindings.includes(id))?.[0];
  if (action) ev.action = action;
  return ev;
}
