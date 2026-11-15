// The canvas vocabulary: the component types a canvas tree may use, the props each
// takes, and the caps every canvas stays under. A node is the same tuple form the
// host's remote-plugin protocol uses — [type, props?, ...children], a child a node
// or a string, and the second element is the props only when it is a plain object
// (the host's normalizeNode reads it the same way). `checkTree` is the gate a tree
// passes before a canvas stores or draws it: an unknown type, an unknown prop, a
// literal colour, a broken shape or a broken cap is refused, with one short message
// naming at most three distinct problems (then a count), so the model fixes the
// tree and draws again. Nothing of a refused tree is ever stored.
export type Node = [type: string, props?: Record<string, unknown>, ...children: (Node | string)[]];
export type TStats = { nodes: number; deepest: number; interactive: number };
export type TChecked = { ok: true; tree: Node; stats: TStats } | { ok: false; error: string };

// The caps a canvas may grow to before checkTree refuses it (the design's "caps are
// enforced before anything is stored"): the whole tree, how deep it nests, how wide
// one node gets, the text a cell may carry, a string prop (a typed value, a label,
// an action), how many controls ask for the keyboard, and the tree serialized.
export const LIMITS: { nodes: number; depth: number; children: number; text: number; value: number; interactive: number; bytes: number } = {
  nodes: 400,
  depth: 8,
  children: 100,
  text: 2000,
  value: 200,
  interactive: 40,
  bytes: 64 * 1024,
};

// The tokens a color/tone prop may name. The theme resolves them when the canvas
// draws; a literal colour is never a value a canvas carries.
export const TONE_TOKENS = ['ok', 'warn', 'error', 'accent', 'dim', 'muted', 'default'];

type PropKind = 'string' | 'number' | 'boolean' | 'array' | 'object';
type ChildKind = 'text' | 'nodes' | 'both';

interface TypeRule {
  props: Record<string, PropKind>;
  required: string[];
  children: ChildKind;
}

interface ItemField {
  name: string;
  kind: 'string' | 'number' | 'token' | 'state';
  cap?: number;
  optional?: boolean;
}

// The whitelist, in the order the vocabulary text names it. A type's `children`
// kind is the kind its children may be; a type whose data lives in its props
// (Table, the composites, the interactive types) takes no children of its own, and
// the brief's three-way kind has no "none", so those take node children and the
// renderer draws them from the props alone.
const ALLOWED: Record<string, TypeRule> = {
  Box: {
    props: { flexDirection: 'string', gap: 'number', padding: 'number', paddingX: 'number', paddingY: 'number', width: 'number', height: 'number', flexGrow: 'number', border: 'boolean', overflow: 'string', alignItems: 'string', justifyContent: 'string' },
    required: [],
    children: 'nodes',
  },
  Text: {
    props: { color: 'string', bold: 'boolean', dim: 'boolean', wrap: 'boolean', truncate: 'boolean' },
    required: [],
    children: 'text',
  },
  Markdown: { props: {}, required: [], children: 'text' },
  Table: {
    props: { columns: 'array', rows: 'array', border: 'boolean', selectedIndex: 'number' },
    required: ['columns', 'rows'],
    children: 'nodes',
  },
  ScrollBox: {
    props: { height: 'number', flexGrow: 'number' },
    required: [],
    children: 'nodes',
  },
  Link: { props: { url: 'string' }, required: ['url'], children: 'text' },
  progress: {
    props: { label: 'string', value: 'number', tone: 'string' },
    required: ['label', 'value'],
    children: 'nodes',
  },
  badge: { props: { text: 'string', tone: 'string' }, required: ['text', 'tone'], children: 'nodes' },
  rows: { props: { items: 'array' }, required: ['items'], children: 'nodes' },
  tasks: { props: { items: 'array' }, required: ['items'], children: 'nodes' },
  rule: { props: { label: 'string' }, required: [], children: 'nodes' },
  input: {
    props: { bind: 'string', label: 'string', placeholder: 'string', value: 'string', width: 'number' },
    required: ['bind'],
    children: 'nodes',
  },
  check: { props: { bind: 'string', label: 'string', value: 'boolean' }, required: ['bind', 'label'], children: 'nodes' },
  select: {
    props: { bind: 'string', label: 'string', options: 'array', value: 'string' },
    required: ['bind', 'options'],
    children: 'nodes',
  },
  button: { props: { label: 'string', action: 'string', tone: 'string' }, required: ['label', 'action'], children: 'nodes' },
};

const TYPES = Object.keys(ALLOWED);
const INTERACTIVE = new Set(['input', 'check', 'select', 'button']);
const TASK_STATES = ['done', 'running', 'queued', 'failed'];
const KIND_NAME: Record<PropKind, string> = { string: 'a string', number: 'a number', boolean: 'a boolean', array: 'an array', object: 'an object' };
// A string the canvas prints as text, capped by LIMITS.text; every other string prop
// is a value (a typed field, a label, an action), capped by LIMITS.value.
const TEXT_PROPS = new Set(['badge.text']);

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const kindOk = (kind: PropKind, v: unknown): boolean => {
  if (kind === 'string') return typeof v === 'string';
  if (kind === 'number') return typeof v === 'number';
  if (kind === 'boolean') return typeof v === 'boolean';
  if (kind === 'array') return Array.isArray(v);
  return isPlainObject(v);
};

export function checkTree(tree: unknown): TChecked {
  const problems: string[] = [];
  const problem = (message: string) => { problems.push(message); };
  const stats: TStats = { nodes: 0, deepest: 0, interactive: 0 };

  // A node as the reader sees it: the second element is the props only when it is a
  // plain object; null/undefined/false children are dropped, as the host's
  // normalizeNode does.
  const readNode = (arr: unknown[]): { props: Record<string, unknown>; children: unknown[] } => {
    const second = arr[1];
    const hasProps = second !== undefined && second !== null && isPlainObject(second);
    const children = (hasProps ? arr.slice(2) : [second, ...arr.slice(2)]).filter((c) => c !== undefined && c !== null && c !== false);
    return { props: hasProps ? (second as Record<string, unknown>) : {}, children };
  };

  // The data-shaped props: every item of the array must carry exactly the fields of
  // its shape (no passthrough), and a printed string stays under the text cap. One
  // message when the shape is broken, one per cell when a string runs long.
  const checkItemArray = (label: string, value: unknown, message: string, fields: ItemField[]) => {
    if (!Array.isArray(value)) return;
    const fieldOk = (f: ItemField, v: unknown): boolean => {
      if (v === undefined) return f.optional === true;
      if (f.kind === 'number') return typeof v === 'number';
      if (typeof v !== 'string') return false;
      if (f.kind === 'token') return TONE_TOKENS.includes(v);
      if (f.kind === 'state') return TASK_STATES.includes(v);
      return true;
    };
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const shapeOk = isPlainObject(item)
        && Object.keys(item).every((k) => fields.some((f) => f.name === k))
        && fields.every((f) => fieldOk(f, item[f.name]));
      if (!shapeOk) { problem(message); return; }
      for (const f of fields) {
        const v = item[f.name];
        if (f.kind === 'string' && f.cap !== undefined && typeof v === 'string' && v.length > f.cap) {
          problem(`${label}[${i}].${f.name} is ${v.length} chars — the limit is ${f.cap}`);
        }
      }
    }
  };

  const checkArrayProp = (type: string, key: string, value: unknown) => {
    if (type === 'Table' && key === 'columns') {
      checkItemArray('Table.columns', value, "Table's columns must be { key, label, width? }", [
        { name: 'key', kind: 'string' },
        { name: 'label', kind: 'string' },
        { name: 'width', kind: 'number', optional: true },
      ]);
    } else if (type === 'Table' && key === 'rows') {
      if (!Array.isArray(value)) return;
      if (value.length > LIMITS.children) problem(`Table has ${value.length} rows — the limit is ${LIMITS.children}`);
      for (const r of value) {
        if (!Array.isArray(r) || !r.every((c) => typeof c === 'string')) { problem("Table's rows must be arrays of strings"); return; }
      }
    } else if (type === 'rows' && key === 'items') {
      checkItemArray("rows' items", value, "rows' items must be { label, value, tone? }", [
        { name: 'label', kind: 'string', cap: LIMITS.text },
        { name: 'value', kind: 'string', cap: LIMITS.text },
        { name: 'tone', kind: 'token', optional: true },
      ]);
    } else if (type === 'tasks' && key === 'items') {
      checkItemArray("tasks' items", value, "tasks' items must be { text, state } — a state is done, running, queued or failed", [
        { name: 'text', kind: 'string', cap: LIMITS.text },
        { name: 'state', kind: 'state' },
      ]);
    } else if (type === 'select' && key === 'options') {
      checkItemArray("select's options", value, "select's options must be { value, label }", [
        { name: 'value', kind: 'string', cap: LIMITS.value },
        { name: 'label', kind: 'string', cap: LIMITS.value },
      ]);
    }
  };

  const checkProps = (type: string, rule: TypeRule, props: Record<string, unknown>) => {
    for (const key of Object.keys(props)) {
      const kind = rule.props[key];
      if (kind === undefined) {
        const names = Object.keys(rule.props);
        problem(`${type} has no prop «${key}» — ${names.length ? `its props are ${names.join(', ')}` : 'it takes no props'}`);
        continue;
      }
      const value = props[key];
      if (!kindOk(kind, value)) {
        problem(`${type}'s ${key} must be ${KIND_NAME[kind]}`);
        continue;
      }
      if ((key === 'color' || key === 'tone') && typeof value === 'string' && !TONE_TOKENS.includes(value)) {
        problem(`${key} must be a palette token (${TONE_TOKENS.slice(0, 2).join(', ')}, …)`);
      }
      if (typeof value === 'string') {
        const cap = TEXT_PROPS.has(`${type}.${key}`) ? LIMITS.text : LIMITS.value;
        if (value.length > cap) problem(`${type}'s ${key} is ${value.length} chars — the limit is ${cap}`);
      }
      if (type === 'progress' && key === 'value') {
        const n = value as number;
        if (n < 0 || n > 100) problem("progress's value must be 0–100");
      }
      if (kind === 'array') checkArrayProp(type, key, value);
    }
    for (const key of rule.required) {
      if (props[key] === undefined) problem(`${type} has no prop «${key}» — its required props are ${rule.required.join(', ')}`);
    }
  };

  const checkChildren = (type: string, rule: TypeRule, children: unknown[], depth: number) => {
    if (children.length > LIMITS.children) problem(`${type} has ${children.length} children — the limit is ${LIMITS.children}`);
    // Markdown is one string, not a list of them.
    if (type === 'Markdown') {
      const texts = children.filter((c) => typeof c === 'string');
      if (texts.length > 1) problem(`Markdown takes one string child, not ${texts.length}`);
    }
    for (const c of children) {
      if (typeof c === 'string') {
        if (rule.children === 'nodes') { problem(`${type} takes node children — wrap the text in a Text`); continue; }
        if (c.length > LIMITS.text) problem(`${type}'s text is ${c.length} chars — the limit is ${LIMITS.text}`);
        continue;
      }
      if (!Array.isArray(c)) { problem('a child must be a node or a string'); continue; }
      if (rule.children === 'text') { problem(`${type} takes text children, not nodes`); continue; }
      walk(c, depth + 1);
    }
  };

  const walk = (node: unknown, depth: number) => {
    if (depth > LIMITS.depth) { problem(`too deep — the limit is ${LIMITS.depth}`); return; }
    if (!Array.isArray(node)) { problem('a node must be [type, props?, ...children]'); return; }
    const type = node[0] as string;
    const rule = ALLOWED[type];
    stats.nodes += 1;
    if (stats.nodes > LIMITS.nodes) problem(`too many nodes — the limit is ${LIMITS.nodes}`);
    stats.deepest = Math.max(stats.deepest, depth);
    if (rule !== undefined && INTERACTIVE.has(type)) {
      stats.interactive += 1;
      if (stats.interactive > LIMITS.interactive) problem(`too many interactive nodes — the limit is ${LIMITS.interactive}`);
    }
    const { props, children } = readNode(node);
    if (rule === undefined) {
      problem(`not drawn: no component «${type}» — the types are ${TYPES.join(', ')}`);
      for (const c of children) if (Array.isArray(c)) walk(c, depth + 1);
      return;
    }
    checkProps(type, rule, props);
    checkChildren(type, rule, children, depth);
  };

  if (!Array.isArray(tree) || typeof tree[0] !== 'string' || !tree[0]) {
    return { ok: false, error: 'the tree must be a node — [type, props?, ...children]' };
  }
  // The serialized size is the whole-canvas cap: over it the tree is refused without
  // a walk, and it also bounds how much a walk may do.
  const bytes = JSON.stringify(tree).length;
  if (bytes > LIMITS.bytes) {
    return { ok: false, error: `tree is too big: ${bytes} bytes — the limit is ${LIMITS.bytes}` };
  }
  walk(tree, 1);
  if (problems.length === 0) return { ok: true, tree: tree as Node, stats };
  // One short message, not a wall: at most three distinct problems, then a count.
  const distinct: string[] = [];
  for (const p of problems) if (!distinct.includes(p)) distinct.push(p);
  const lines = distinct.slice(0, 3);
  if (distinct.length > 3) lines.push(`…and ${distinct.length - 3} more`);
  return { ok: false, error: lines.join('\n') };
}

// The tool-facing reference the model composes against: one line per type with its
// props, the caps in one line, the palette tokens, and one whole example tree (the
// design's pipeline panel). The group description (Task 4) shows it to the model.
export const VOCABULARY = `canvas components — a tree is [type, props?, ...children]; a child is a node or a string:
Box: flexDirection, gap, padding, paddingX, paddingY, width, height, flexGrow, border, overflow, alignItems, justifyContent — takes node children
Text: color (a palette token), bold, dim, wrap, truncate — takes a string child
Markdown: takes one string child
Table: columns ({key, label, width?}), rows (arrays of strings, ≤ 100), border, selectedIndex
ScrollBox: height, flexGrow — takes node children
Link: url — takes a string child
progress: label, value (0–100), tone
badge: text, tone
rows: items ({label, value, tone?})
tasks: items ({text, state: done|running|queued|failed})
rule: label?
input: bind, label?, placeholder?, value?, width?
check: bind, label, value?
select: bind, label?, options ({value, label}[]), value?
button: label, action, tone?
caps: ≤ 400 nodes · depth ≤ 8 · ≤ 100 children per node · ≤ 2000 chars of text · ≤ 200 chars per value · ≤ 40 interactive nodes · ≤ 64 KB serialized
palette tokens: ok, warn, error, accent, dim, muted, default
example — a GitLab pipeline:
[Box, {flexDirection: 'column', gap: 1},
  [badge, {text: 'failed · 2m', tone: 'error'}],
  [rows, {items: [{label: 'project', value: 'portals/frontend-services/prices-index'},
                  {label: 'commit', value: 'a3f19c2'}]}],
  [progress, {label: 'jobs passed', value: 75, tone: 'warn'}],
  [tasks, {items: [{text: 'build', state: 'done'}, {text: 'lint', state: 'done'},
                   {text: 'test:unit', state: 'running'}, {text: 'deploy:stage', state: 'queued'}]}],
  [Box, {flexDirection: 'row', gap: 2},
    [input, {bind: 'branch', label: 'branch', value: 'feature-MP-123'}],
    [check, {bind: 'watch', label: 'watch it', value: true}],
    [button, {label: 'check again', action: 'check the pipeline for this branch again'}]],
  [Link, {url: 'https://gitlab…/pipelines/1234'}]]`;
