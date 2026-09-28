// The person's `!command` and `!!command`, run in a conversation. A function over a
// Conversation, which holds the state; its method calls it, and the chat answers its
// events (AGENTS.md, "The chat").
import { capConsoleData, consoleData } from './console-view.js';
import { INTERACTIVE_ASK, runInteractive, type InteractiveDeps } from './interactive.js';
import { outputJournal } from './journal.js';
import { encodeBangLine, pushHistory } from './prompt-history.js';
import type { ShellMeta } from './recall.js';
import { formatShell, nextCwd, runMark, runShell as execShell, shellLimits, shellOutcome, tildePath, type ShellResult } from './shell.js';
import type { ViewRecord } from './views.js';
import { keyGlyph } from '../playback/keys.js';
import { callOf } from './conversation-types.js';
import type { Conversation } from './conversation.js';

// ── `!command` — the person runs a shell command (src/assistant/shell.ts) ──
// The chat is busy exactly as while an answer is written — the same spinner,
// and Esc stops it — but no model turn is spent: the result joins the model's
// history and is read with the person's next message.
// `interactive` is `!!command` (src/assistant/interactive.ts): the program gets
// the terminal, what it printed is recorded, and once it is back the recording
// lands the same way — and a turn starts at once with the host's ask to look at
// it. Refused while anything runs, exactly as `!` is: a program taking the
// terminal under a running turn would put its recording in the middle of that
// turn's history, and hide a y/n the turn may be waiting on.
// The caller has refused a busy conversation and an empty command (the chat's own words).
export async function runShell(c: Conversation, cmd: string, interactive = false): Promise<void> {
  c.busy = true; // closed synchronously, as in a turn
  c.busyKind = interactive ? 'interactive' : 'shell';
  pushHistory(c.prompts, encodeBangLine(interactive ? 2 : 1, cmd));
  c.setEmptyAnswer(false); c.setContinueOffer(false);
  c.setToolCount(0);
  c.mirror.setStreaming(true);
  // The mark says how it ran, `!` or `‼`.
  c.setToolLabel(`${runMark(interactive)} ${cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd}`);
  c.turnStartedAt = Date.now();
  // The command is the only thing running, so the segment is the whole of it.
  c.beginSegment();
  // The chat: the history walk ends, the field empties (the command is in its block from
  // here on), the error line goes, the ticker starts, the Esc arm goes.
  c.emit({ type: 'turn-start', kind: c.busyKind, label: c.toolLabel });
  const abort = new AbortController();
  c.abort = abort;
  c.stopKey = '';
  const cwd = c.shell.cwd();
  const { timeoutMs, maxChars } = shellLimits(c.deps.config() as { shell?: unknown });
  let stopped = false;
  let failed = false;
  // The person's command gets the same live block as the model's. The message
  // is still role `shell`: it joins c.api and ↑/↓ as it always did. Declared
  // OUTSIDE the try so the catch below can still find the message by `callId`
  // if something throws after it was pushed; `epoch` is this command's own
  // conversation identity, captured now — a completion that arrives after a
  // LATER /clear (or /resume) must not touch the fresh
  // conversation's messages, session-facing history or shell directory.
  const startedAt = Date.now();
  const callId = `shell#${startedAt}`;
  const liveRec = (data: unknown, phase: ViewRecord['phase'] = 'live'): ViewRecord => ({ kind: 'console', data, phase, startedAt, callId });
  const epoch = c.epoch;
  // Set once an interactive run's recording has joined the model's history: the
  // turn that looks at it starts when this command is done (the `finally`).
  let ask = false;
  // In the journal from the moment it starts — a crash mid-command still leaves
  // what ran; its end, when it comes, goes to the same session.
  const journalId = c.journal({ t: 'shell', command: cmd, cwd: tildePath(cwd), ...(interactive ? { interactive: true } : {}) }, { person: true });
  // Its output, whole, as it arrives — the screen and the model keep only its
  // tail; the journal keeps up to OUTPUT_CAP of it.
  const outJournal = outputJournal((ev) => c.journalTo(journalId, ev));
  try {
    c.liveSeen.add(callId);
    c.mirror.setMessages((cur) => [...cur, { role: 'shell', content: '', command: cmd, views: [{ ...liveRec(capConsoleData({ command: cmd, cwd: tildePath(cwd), text: '', showCwd: true, interactive })), turn: c.turn }] }]);
    let raw = '';
    const onOutput = (chunk: string) => {
      outJournal.push(chunk);
      raw += chunk;
      if (raw.length > maxChars * 2) raw = raw.slice(-maxChars);
      c.offerLive(liveRec(capConsoleData({ command: cmd, cwd: tildePath(cwd), text: raw, showCwd: true })), epoch);
    };
    // The interactive run holds no AbortController of its own: while it runs the
    // terminal is the program's, and no key reaches the chat (flowtty's TTY
    // backend stops reading its input for the hand-over) — Esc and Ctrl+C are
    // the program's keys.
    let recorded = true;
    let r: ShellResult;
    if (interactive) {
      const svc = c.deps.services() as { suspend?: <T>(fn: () => T | Promise<T>) => Promise<T>; interactive?: InteractiveDeps };
      const run = await runInteractive(cmd, { cwd, maxChars, suspend: svc.suspend ?? (async (fn) => fn()) }, svc.interactive ?? {});
      r = run.result;
      recorded = run.recorded;
    } else {
      r = await execShell(cmd, { cwd, timeoutMs, maxChars, signal: abort.signal, onOutput });
    }
    stopped = r.stopped;
    if (r.stopped && c.stopKey) r.stoppedBy = c.stopKey;
    // Its end, whatever happened to the conversation meanwhile — it ran there.
    // `output` is what the host holds: the last `shell.maxChars` of it.
    // An interactive run has no stream: its recording is what there is.
    if (interactive) outJournal.push(r.output);
    outJournal.end();
    c.journalTo(journalId, { t: 'shell-end', command: cmd, status: shellOutcome(r, timeoutMs), ms: r.ms });
    const move = nextCwd(c.deps.config() as Record<string, unknown>, cwd, r.pwd);
    const { display, forModel } = formatShell(cmd, r, cwd, timeoutMs, { after: move.cwd, note: move.note, ...(interactive ? { interactive: { recorded } } : {}) });
    // Everything from here on is display/model-facing state for THIS
    // conversation — skipped whole for a stale epoch (a /clear mid-command:
    // the command still finishes, and without this its block would land in
    // the fresh, cleared chat).
    if (epoch === c.epoch) {
      // `cd` sticks, as in a terminal — within the roots.
      if (move.cwd !== cwd) c.shell.setCwd(move.cwd);
      c.flushLive();
      // The block says where a `cd` inside the command left the directory — or
      // that one tried to leave the roots and stayed — the same facts the old
      // markdown line carried, now on the live view instead.
      const data = consoleData(cmd, r, cwd, timeoutMs, true, { movedTo: tildePath(move.cwd), note: move.note, interactive });
      c.mirror.setMessages((cur) => {
        const next = cur.slice();
        const at = next.findLastIndex((m) => callOf(m) === callId);
        const done = { role: 'shell', content: display, command: cmd, views: [{ ...liveRec(data, 'done'), turn: c.turn }] };
        if (at >= 0) next[at] = done; else next.push(done);
        return next;
      });
      // An interactive run reaches the model only with something to look at: no
      // `script` to record with, or nothing left once the full-screen program's
      // own screen is dropped (vim, less, top), and it is only a block on screen —
      // a turn spent on "(no output)" would cost a request for nothing.
      const seen = !interactive || (recorded && !!r.output.trim());
      // Beside the text, what its stub says once a batch stubs it (src/assistant/
      // recall.ts): the command, how it ended, how long, how many lines.
      const printed = r.output.replace(/\n+$/, '');
      const meta: ShellMeta = { command: cmd, outcome: shellOutcome(r, timeoutMs), ms: r.ms, lines: printed ? printed.split('\n').length : 0, ...(interactive ? { interactive: true } : {}) };
      if (seen) c.api = [...c.api, { role: 'shell', content: forModel, shell: meta }];
      if (interactive && !r.error && !seen) {
        const why = recorded
          ? 'Nothing was printed outside the full-screen program — the assistant was not asked.'
          : 'No usable `script` on PATH — the program ran with the terminal, but nothing was recorded, so the assistant was not asked.';
        c.pushNote(why);
      }
      ask = interactive && seen;
    }
    c.deps.pushLog(`[shell] ${interactive ? '!! ' : ''}${cmd.slice(0, 60)} → ${r.error ? `error: ${r.error}` : r.stopped ? 'stopped' : r.timedOut ? 'timed out' : r.signal ? `killed by ${r.signal}` : `exit ${r.code}`}`);
  } catch (e) {
    stopped = true; // a command that could not run keeps the queue, as a failed turn does
    failed = true;
    c.emit({ type: 'notice', text: `!: ${(e as Error).message}`, level: 'error' });
    outJournal.end();
    c.journalTo(journalId, { t: 'shell-end', command: cmd, status: `could not run: ${(e as Error).message}`, ms: Date.now() - startedAt });
    // The block stops ticking rather than waiting forever for a completion
    // that is never coming — marked failed in place, keeping whatever it had
    // already shown (the way a tool's own thrown view does, agent.ts).
    if (epoch === c.epoch) {
      c.mirror.setMessages((cur) => {
        const next = cur.slice();
        const at = next.findLastIndex((m) => callOf(m) === callId);
        if (at < 0) return cur;
        const target = next[at]!;
        const views = (target.views as ViewRecord[] | undefined) ?? [];
        if (!views.length) return cur;
        next[at] = { ...target, views: [{ ...views[0]!, phase: 'failed', turn: c.turn }] };
        return next;
      });
    }
  } finally {
    // An interactive run that was recorded goes on into the turn that looks at
    // it. The chat stays BUSY until that turn has started (the `send` waits one
    // tick, for the render that carries the command's block): a message typed
    // in between queues behind the ask, as behind any turn — never ahead of it.
    const askNow = ask && epoch === c.epoch;
    c.busy = askNow;
    if (epoch === c.epoch) c.flushLive();
    c.persist();
    if (!askNow) c.mirror.setStreaming(false);
    // A command of the person's may have changed a settings file (the guard).
    void c.askConfigChanges();
    c.setToolLabel('');
    c.abort = null;
    c.lastEnd = {
      kind: interactive ? 'interactive' : 'shell',
      outcome: failed ? 'failed' : stopped ? 'stopped' : 'done',
      ms: Date.now() - c.turnStartedAt,
      ...(stopped && !failed ? { stoppedBy: c.stopKey || keyGlyph('escape') } : {}),
    };
    // The chat: the ticker stops at the command's time; a stopped command's queue — or
    // one that could not run — comes back into the field.
    c.emit({ type: 'turn-end', end: c.lastEnd });
    if (askNow) {
      setTimeout(() => {
        c.busy = false;
        if (epoch !== c.epoch) { c.mirror.setStreaming(false); return; }
        void c.send(INTERACTIVE_ASK, { hostAsk: true });
      }, 0);
    }
    // What the person queued meanwhile goes out now — unless they stopped the command:
    // then it came back into the field (the chat, on `turn-end`), as after a stopped
    // answer; the inbox after it.
    else c.afterTurn(!stopped);
    c.deps.notify();
  }
}
