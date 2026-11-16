// Recognizes an answer that has degenerated into a repeating loop, so the turn can be
// stopped instead of paying for and keeping the debris (the design's "when the answer
// loops — stop it"). `push` is fed the accumulated answer text — not a delta, and
// already redacted by the caller — and answers null until the tail has become
// periodic enough to be a loop, then the same hit for the rest of the text.
//
// The test: some unit of 1..unitMax code units repeats exactly and the run of whole
// repeats reaches minRun code units. Exact repeats only, so a fenced listing of code
// closers, a table, and a quote reused with prose between it are not a loop; identical
// short lines sustained past minRun are, and are stopped visibly (the module's tests
// pin both sides).
//
// The tail only supplies candidate units: the walk counts whole repeats back from the
// end of the text, so `at` names the run's true start even when the run is longer than
// the tail. A partial unit at the run's start is not counted, which is what lets the
// kept text end before the run rather than inside a repeat.
//
// Pure: no imports, no config, no clock. Offsets are UTF-16 code units of the text.
//
// One guard per answer.

// How much of the text's end is looked at for candidate units.
export const LOOP_TAIL = 512;
// The longest unit considered a repetition rather than a line of content.
export const LOOP_UNIT_MAX = 32;
// How many code units of repeats it takes to call the tail a loop.
export const LOOP_MIN_RUN = 400;

export interface LoopHit {
  // The offset the kept text ends at: the start of the sustained repeat run.
  at: number;
  // The unit the run repeats.
  unit: string;
  // How many code units the run holds; `at + dropped` is the text's length.
  dropped: number;
}

export interface LoopGuard {
  push(text: string): LoopHit | null;
}

// How many whole copies of `unit` end at the end of `text`, walking back as far as the
// text allows. The unit is compared as a string, so only exact repeats count; where
// fewer than `unit.length` characters are left, that partial copy is not counted.
function countRepeats(text: string, unit: string): number {
  if (unit === '') return 0;
  let end = text.length;
  let repeats = 0;
  while (end >= unit.length && text.slice(end - unit.length, end) === unit) {
    end -= unit.length;
    repeats++;
  }
  return repeats;
}

export function createLoopGuard(opts: { tail?: number; unitMax?: number; minRun?: number } = {}): LoopGuard {
  const tailLen = opts.tail ?? LOOP_TAIL;
  const unitMax = opts.unitMax ?? LOOP_UNIT_MAX;
  const minRun = opts.minRun ?? LOOP_MIN_RUN;
  let fired: LoopHit | null = null;
  return {
    push(text) {
      if (fired) return fired;
      const tail = text.slice(-tailLen);
      // The smallest unit wins: a loop of a shorter unit is the more specific finding.
      for (let p = 1; p <= unitMax; p++) {
        const unit = tail.slice(-p);
        const repeats = countRepeats(text, unit);
        if (p * repeats < minRun) continue;
        fired = { at: text.length - p * repeats, unit, dropped: p * repeats };
        return fired;
      }
      return null;
    },
  };
}
