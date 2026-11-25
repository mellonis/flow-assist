// A fixture that waits by hopping and gives up quietly reads as success: the assertion
// after it fails on a frame nobody can connect to the wait that actually gave up, or —
// worse — passes on something the wait never reached. Every wait is the shared
// `settleUntil` (helpers/scripted.ts), which throws and names itself. This test is the
// tripwire: a hop loop anywhere in the trees the suite runs, or a local waiter under one
// of the suite's names that does not delegate, fails it by file name.
//
// A bounded OBSERVATION is not a wait: a probe returning a boolean that its caller
// asserts (`heldWithin`) claims nothing beyond what it returns, and the delegation rule
// exempts it by its `Promise<boolean>`.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const helpers = import.meta.dir;
const src = path.resolve(helpers, '../..');
const root = path.resolve(src, '..');
const self = path.resolve(helpers, 'no-silent-waits.test.ts');

// The trees the acceptance command runs (`bun test ./src ./scripts ./packages`): a hop
// loop in a script is no less silent for having no test beside it.
const TREES = ['src', 'scripts', 'packages'].map((d) => path.join(root, d));

function filesUnder(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') filesUnder(full, out);
    } else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const text = (f: string) => fs.readFileSync(f, 'utf8');
const rel = (f: string) => path.relative(root, f);
const lineAt = (t: string, index: number) => t.slice(0, index).split('\n').length;

// The braced block opening at `brace`.
function braced(t: string, brace: number): string {
  let depth = 0;
  for (let i = brace; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}' && --depth === 0) return t.slice(brace, i + 1);
  }
  return t.slice(brace);
}

// A definition's body: an arrow's expression (to the end of its line) or its braced block;
// a method's block. An object literal in an arrow body is not the body.
function bodyOf(t: string, from: number, method: boolean, openingBrace: number): string {
  if (method) return braced(t, openingBrace);
  const arrow = t.indexOf('=>', from);
  const lineEnd = t.indexOf('\n', from);
  if (arrow < 0 || (lineEnd >= 0 && lineEnd < arrow)) return t.slice(from, lineEnd < 0 ? undefined : lineEnd);
  const after = arrow + 2;
  const end = t.indexOf('\n', after);
  const rest = t.slice(after, end < 0 ? undefined : end);
  const first = rest.search(/\S/);
  // A block body starts with `{`; anything else is an expression, and an object literal
  // in it (`{ ms }`) is a value, not the body.
  if (first < 0 || rest[first] !== '{') return rest;
  return braced(t, after + first);
}

test('no test waits in a hop loop that cannot fail', () => {
  // A loop whose body is a settle hop and nothing else, whatever its bound or counter.
  // The shape takes every spelling a local copy had: `for (let i = 0; i < n && !ok(); i++)
  // await settle(1)`, the braced form, another counter's name, `for (const x of …)`.
  const hop = [
    /for \([^\n]*\)\s*await settle\(/,
    /for \([^\n]*\)\s*\{\s*await settle\([^;]*\);\s*\}/,
    /while \([^\n]*\)\s*await settle\(/,
    /while \([^\n]*\)\s*\{\s*await settle\([^;]*\);\s*\}/,
    // And the clock bound, which hides the same give-up behind `while (Date.now() < end)`.
    /while \(\s*Date\.now\(\)[^\n]*\)\s*\{[^}]{0,300}await settle\(/,
  ];
  const offenders = TREES.flatMap((dir) => filesUnder(dir))
    .filter((f) => f !== self)
    .filter((f) => hop.some((re) => re.test(text(f))))
    .map(rel);
  expect(offenders).toEqual([]);
});

test('a local waiter delegates to the shared one, so its give-up names itself', () => {
  // A local waiter is a const arrow or an object method that takes a CONDITION — the
  // suite's name for it varies (`settleUntil`, `until`, `settleReal`), its signature does
  // not. A sleep helper (`wait(ms)`) waits for nothing and is not one.
  const names = 'settleUntil|until|wait|waitFor|heldWithin|settleReal';
  const condition = /\(\s*(?:ui[^,]*,\s*)?(?:ok|cond):\s*\(\)\s*=>\s*boolean/;
  const observation = /Promise<boolean>/;
  const definitions = [
    { re: new RegExp(`(?:^|\\n)(?:export\\s+)?const\\s+(${names})\\s*=`, 'g'), method: false },
    // A method's parameters may nest one level (`ok: () => boolean`).
    { re: new RegExp(`(?:^|\\n)\\s+(?:async\\s+)?(${names})\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*(?::[^{]+)?\\{`, 'g'), method: true },
  ];
  const offenders: string[] = [];
  for (const f of filesUnder(path.join(src, '__tests__'))) {
    // The shared wait itself: its own give-up is the one every other waiter borrows.
    if (f === self || f === path.join(helpers, 'scripted.ts')) continue;
    const t = text(f);
    for (const { re, method } of definitions) {
      for (const m of t.matchAll(re)) {
        const whole = m[0];
        const at = (m.index ?? 0) + whole.length;
        // The signature only: a neighbouring definition's parameters are not this one's.
        const after = method ? at : t.indexOf('=>', at);
        const signature = t.slice(m.index ?? 0, after > at ? after : at);
        if (!condition.test(signature) || observation.test(signature)) continue;
        const body = bodyOf(t, at, method, at - 1);
        if (!/settleUntil(?:Shared)?\(/.test(body)) offenders.push(`${rel(f)}:${lineAt(t, m.index ?? 0)}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
