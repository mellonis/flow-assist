// What a `console.log` / `warn` / `error` printed while the app owns the screen — a
// plugin's stray line, a library's, React's own warnings — goes to the host log (`L`)
// at once. The TTY backend takes the console over while it holds the alternate screen
// and hands each line to `onConsole`; with that set it
// prints nothing at exit, so the log is where such a line is read.
//
// A line is never logged where it was printed: React prints its warnings in the middle
// of a render, and the log's refresh is a setState — "cannot update a component while
// rendering" again, printed by the very thing that is logging it. So every line is
// delivered on a microtask. Lines printed before the App is up are held until it is.

export type ConsoleLevel = 'log' | 'info' | 'debug' | 'warn' | 'error';

// `[console] …` for a plain line, `[console.warn] …` / `[console.error] …` otherwise —
// the log colours a line that says `error` as a failure. A line of several (a stack) is
// one entry per line, each with the prefix, so every one of them reads on its own.
export function consoleLogLines({ level, line }: { level: ConsoleLevel; line: string }): string[] {
  const prefix = level === 'log' ? '[console]' : `[console.${level}]`;
  return line.split('\n').filter((l) => l.trim() !== '').map((l) => `${prefix} ${l}`);
}

export interface ConsoleBridge {
  // The backend's `onConsole`.
  onConsole: (entry: { level: ConsoleLevel; line: string }) => void;
  // Where the lines go once the app is up; what was held is delivered first.
  attach: (push: (line: string) => void) => void;
}

export function consoleBridge(): ConsoleBridge {
  let push: ((line: string) => void) | null = null;
  const held: string[] = [];
  return {
    onConsole: (entry) => {
      const lines = consoleLogLines(entry);
      if (!lines.length) return;
      queueMicrotask(() => {
        if (push) for (const l of lines) push(l);
        else held.push(...lines);
      });
    },
    attach: (fn) => {
      push = fn;
      for (const l of held.splice(0)) fn(l);
    },
  };
}
