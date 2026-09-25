// What a plugin's `frame` must be to be drawn (docs/plugins.md, "A plugin in another
// language"). A frame that fails is dropped whole and the previous one stays; the
// caps keep a runaway plugin from taking the host's memory or the stack.
import type { Frame, Node, Props, Tree } from '@flow-assist/remote';

export const FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const FRAME_MAX_DEPTH = 64;

export type Validated = { ok: true; frame: Required<Frame> & { keys: { consume: string[] | '*' } } } | { ok: false; why: string };

// A node as the renderer reads it: `[type]`, `[type, props, ...children]`, or
// `[type, child, ...]` with the props left out. `null`/`false`/`undefined` children are
// dropped, as React drops them. Not a node: null.
export function normalizeNode(n: unknown): { type: string; props: Props; children: unknown[] } | null {
  if (!Array.isArray(n) || typeof n[0] !== 'string' || !n[0]) return null;
  const [type, second, ...rest] = n as Node;
  const hasProps = second !== undefined && second !== null && typeof second === 'object' && !Array.isArray(second);
  const children = (hasProps ? rest : [second, ...rest]).filter((c) => c !== null && c !== undefined && c !== false);
  return { type, props: hasProps ? (second as Props) : {}, children };
}

function checkTree(t: unknown, depth: number, where: string): string | null {
  if (t === null || t === undefined) return null;
  if (depth > FRAME_MAX_DEPTH) return `${where} is more than ${FRAME_MAX_DEPTH} deep`;
  const node = normalizeNode(t);
  if (!node) return `${where} is not a node ([type, props, ...children])`;
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    const bad = checkTree(c, depth + 1, where);
    if (bad) return bad;
  }
  return null;
}

export function validateFrame(raw: unknown, sizeBytes: number): Validated {
  if (sizeBytes > FRAME_MAX_BYTES) return { ok: false, why: `${(sizeBytes / 1048576).toFixed(1)} MiB, over the ${FRAME_MAX_BYTES / 1048576} MiB frame limit` };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: 'not an object' };
  const f = raw as Record<string, unknown>;
  const surface = (f.surface ?? null) as Tree | null;
  const badSurface = checkTree(surface, 1, 'surface');
  if (badSurface) return { ok: false, why: badSurface };
  const modals: Record<string, Tree | null> = {};
  if (f.modals !== undefined) {
    if (!f.modals || typeof f.modals !== 'object' || Array.isArray(f.modals)) return { ok: false, why: 'modals is not an object' };
    for (const [name, tree] of Object.entries(f.modals as Record<string, unknown>)) {
      const bad = checkTree(tree ?? null, 1, `modals.${name}`);
      if (bad) return { ok: false, why: bad };
      modals[name] = (tree ?? null) as Tree | null;
    }
  }
  const keycaps = Array.isArray(f.keycaps) ? f.keycaps.filter((k): k is string | { action: string; label: string } => typeof k === 'string' || (!!k && typeof k === 'object' && typeof (k as { action?: unknown }).action === 'string' && typeof (k as { label?: unknown }).label === 'string')) : [];
  const context = Array.isArray(f.context) ? f.context.filter((c): c is { label: string; text: string } => !!c && typeof c === 'object' && typeof (c as { label?: unknown }).label === 'string' && typeof (c as { text?: unknown }).text === 'string') : [];
  let consume: string[] | '*' = [];
  if (f.keys !== undefined) {
    const k = f.keys as { consume?: unknown } | null;
    if (!k || typeof k !== 'object') return { ok: false, why: 'keys is not an object' };
    if (k.consume === '*') consume = '*';
    else if (k.consume === undefined) consume = [];
    else if (Array.isArray(k.consume) && k.consume.every((s) => typeof s === 'string')) consume = k.consume as string[];
    else return { ok: false, why: 'keys.consume is not a list of keys or "*"' };
  }
  return { ok: true, frame: { surface, modals, keycaps, context, keys: { consume } } };
}
