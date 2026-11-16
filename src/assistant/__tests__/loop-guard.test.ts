// The loop detector (src/assistant/loop-guard.ts): an answer that degenerates into a
// repeating unit is caught within the guarantee, and legitimate repetition — code
// closers, table rows, a quote reused with prose between it — is not.
import { expect, test } from 'bun:test';
import { LOOP_MIN_RUN, LOOP_UNIT_MAX, LOOP_TAIL, createLoopGuard, type LoopHit } from '../loop-guard.ts';

// Feeds the guard a growing text, unit by unit, and answers the first hit with the
// text that produced it — the push whose run first crosses the threshold.
function firstHit(prefix: string, unit: string, most: number): { hit: LoopHit; text: string } {
  const guard = createLoopGuard();
  for (let n = 1; n <= most; n++) {
    const text = prefix + unit.repeat(n);
    const hit = guard.push(text);
    if (hit) return { hit, text };
  }
  throw new Error(`no hit in ${most} repeats of ${JSON.stringify(unit)}`);
}

test('the defaults are the plan\'s thresholds', () => {
  expect(LOOP_TAIL).toBe(512);
  expect(LOOP_UNIT_MAX).toBe(32);
  expect(LOOP_MIN_RUN).toBe(400);
});

test('a word salad loop is caught within the guarantee', () => {
  const prose = 'Here is the plan. ';
  const unit = 'дизайн ';
  const { hit, text } = firstHit(prose, unit, 80);
  expect(hit.unit).toBe(unit);
  // The kept text ends where the run begins, so no repeat survives in it.
  expect(hit.at).toBe(prose.length);
  expect(text.slice(0, hit.at)).toBe(prose);
  expect(hit.dropped).toBe(text.length - hit.at);
  // Fired on the first push whose run reaches the threshold, not later.
  expect(hit.dropped).toBeGreaterThanOrEqual(LOOP_MIN_RUN);
  expect(hit.dropped - unit.length).toBeLessThan(LOOP_MIN_RUN);
});

test('a glued loop is caught too', () => {
  const prose = 'Answer: ';
  const unit = 'дизайн';
  const { hit, text } = firstHit(prose, unit, 90);
  expect(hit.unit).toBe(unit);
  expect(hit.at).toBe(prose.length);
  expect(text.slice(0, hit.at)).toBe(prose);
  expect(hit.dropped).toBeGreaterThanOrEqual(LOOP_MIN_RUN);
  expect(hit.dropped - unit.length).toBeLessThan(LOOP_MIN_RUN);
});

test('code closers and table rows are not a loop', () => {
  const closers = '  </div>\n'.repeat(30);
  expect(closers.length).toBe(270); // under minRun, so even identical lines stay
  expect(createLoopGuard().push('some html:\n' + closers)).toBeNull();

  const words = ['alpha', 'beta', 'gamma', 'delta'];
  const rows = Array.from({ length: 60 }, (_, i) =>
    `| ${i + 1} | ${words[i % words.length]} | row ${i * 7 + 3} |\n`);
  const guard = createLoopGuard();
  let table = 'Here is the table:\n';
  for (const row of rows) {
    table += row;
    expect(guard.push(table)).toBeNull();
  }
});

test('identical lines over the threshold do fire', () => {
  const unit = '<!-- x -->\n';
  const { hit, text } = firstHit('', unit, 50);
  expect(hit.unit).toBe(unit);
  expect(hit.at).toBe(0);
  expect(hit.dropped).toBe(text.length);
  expect(hit.dropped).toBeGreaterThanOrEqual(LOOP_MIN_RUN);
  expect(hit.dropped - unit.length).toBeLessThan(LOOP_MIN_RUN);
});

test('a quote repeated with prose between it never fires', () => {
  const quote = '«Сначала подумай, потом напиши»';
  const guard = createLoopGuard();
  let text = '';
  for (let i = 1; i <= 20; i++) {
    text += `Шаг ${i}: ${quote} — и потом ещё одна мысль номер ${i}, своими словами.\n`;
    expect(guard.push(text)).toBeNull();
  }
});

test('a run longer than the tail still points at the run start', () => {
  // A caller feeds the guard accumulated text, so one push can carry the whole loop (a
  // round answered at once). `at` is the run's start, not the start of the tail.
  const hit = createLoopGuard().push('ok ' + 'loop '.repeat(200));
  expect(hit).toEqual({ at: 3, unit: 'loop ', dropped: 1000 });
});

test('the guard fires once', () => {
  const guard = createLoopGuard();
  const unit = 'loop ';
  let hit: LoopHit | null = null;
  let text = '';
  for (let n = 1; n <= 200; n++) {
    text = unit.repeat(n);
    hit = guard.push(text);
    if (hit) break;
  }
  expect(hit).not.toBeNull();
  expect(hit!.at).toBe(0);
  expect(hit!.dropped).toBe(LOOP_MIN_RUN);
  expect(guard.push(text + unit.repeat(10))).toBe(hit!);
  expect(guard.push('a different answer entirely')).toBe(hit!);
});
