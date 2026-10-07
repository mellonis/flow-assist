// When a `y` or `n` may answer the y/n of a subagent (AGENTS.md (subagent y/n)). A
// subagent's request arrives while the person is doing something else, often typing; a key
// meant for the field must never become a yes to another agent's write. So an answer counts
// only after a pause: a stretch after the block came on screen, and a stretch after the
// person's last key of any kind.

// How long the block, and the person's last key, must have been quiet.
export const ASK_ARM_MS = 600;

// The clock the guard reads. A seam for tests, which move it instead of sleeping.
export const askClock: { now: () => number } = { now: () => Date.now() };

export interface AskGuard {
  // The request the chat shows now, or null when none is shown. A request seen for the
  // first time, or again after a gap with none shown, arms from this moment.
  show(request: object | null): void;
  // A key arrived: whether an answer would count as of BEFORE it, then the key is noted.
  press(): boolean;
  // A key the host took before the chat heard it: noted as the last keystroke, no answer.
  note(): void;
}

export function createAskGuard(): AskGuard {
  let shown: object | null = null;
  let shownAt = 0;
  let lastKey = Number.NEGATIVE_INFINITY;
  return {
    show(request) {
      if (request === shown) return;
      shown = request;
      shownAt = request ? askClock.now() : 0;
    },
    press() {
      const now = askClock.now();
      const armed = shown !== null && now - shownAt >= ASK_ARM_MS && now - lastKey >= ASK_ARM_MS;
      lastKey = now;
      return armed;
    },
    note() {
      lastKey = askClock.now();
    },
  };
}
