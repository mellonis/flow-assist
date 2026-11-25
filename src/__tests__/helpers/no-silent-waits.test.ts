// A fixture that waits by hopping and gives up quietly reads as success: the assertion
// after it fails on a frame nobody can connect to the wait that actually gave up, or —
// worse — passes on something the wait never reached. Every wait here is the shared
// `settleUntil` (helpers/scripted.ts), which throws and names itself. This test is the
// tripwire: a new local loop or a local waiter that does not delegate fails it, and the
// failure names the file.
//
// A bounded OBSERVATION is not a wait: `until(cond)` returning a boolean, used as a
// predicate, lives outside `src/__tests__` and is deliberately not covered — it claims
// nothing beyond what it returns.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const helpers = import.meta.dir;
const src = path.resolve(helpers, '../..');
const self = path.resolve(helpers, 'no-silent-waits.test.ts');

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, out);
    // Every fixture, a helper included: a silent waiter there hides behind the tests it
    // serves just as well as one in a test file.
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const text = (f: string) => fs.readFileSync(f, 'utf8');
const rel = (f: string) => path.relative(src, f);

test('no test waits in a hop loop that cannot fail', () => {
  // The shape every local copy had: a bound loop hopping on `settle`, which returns
  // whether or not the condition ever held — with any bound and any condition, since a
  // different name hid the same silence.
  const hop = /for \((?:let|const) i = 0; i < [^;\n]+; i\+\+\) await settle\(/;
  // And the clock bound, which hid the same give-up behind `while (Date.now() < end)`.
  const clock = /while \(Date\.now\(\) < [^\n]*\)[^\n]*await settle/;
  const offenders = filesUnder(src)
    .filter((f) => f !== self)
    .filter((f) => hop.test(text(f)) || clock.test(text(f)))
    .map(rel);
  expect(offenders).toEqual([]);
});

test('a local waiter delegates to the shared one, so its give-up names itself', () => {
  const start = /^const (settleUntil|until) = .*$/m;
  const delegates = /settleUntil(Shared)?\(/;
  const offenders: string[] = [];
  for (const f of filesUnder(path.join(src, '__tests__'))) {
    const lines = text(f).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!start.test(lines[i]!)) continue;
      let end = i;
      if (!lines[i]!.includes('};')) while (end + 1 < lines.length && lines[end + 1]!.trim() !== '};') end++;
      if (!delegates.test(lines.slice(i, end + 1).join('\n'))) offenders.push(`${rel(f)}:${i + 1}`);
    }
  }
  expect(offenders).toEqual([]);
});
