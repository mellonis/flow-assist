// The schedule of a child conversation: start it, arm its delay, and when the delay ends
// admit its run into a slot and report how it ended (AGENTS.md (child schedule)). The
// `subagent` tool and any caller outside a turn share it, so the order is one:
// start → timer → disarm → fired → admit → run → log / toast → notify.
import { childResultBody, type ChildResult, type LaterTurn, type ChildSpec, type ChildStart } from './conversation-types.js';
import type { Conversation } from './conversation.js';
import type { ChildSlots } from './registry.js';

export interface ChildScheduleDeps {
  // The conversation's `startChild` bound to the journal id the child's lines go under.
  startChild: (spec: ChildSpec) => ChildStart;
  slots: ChildSlots;
  showMessage?: (m: string) => void;
  pushLog?: (e: string) => void;
  notify?: () => void;
}

export type ChildScheduled = { refused: string } | { child: Conversation; label: string };

export function scheduleChild(spec: ChildSpec, delayMs: number, deps: ChildScheduleDeps): ChildScheduled {
  const { slots } = deps;
  const label = spec.label;
  // Whether this child's wait for the person is counted against its slot. A running child
  // that parks a y/n or a question to its parent gives its slot up until the answer; the count is kept here, from the
  // child's own `confirm` and `ask-parent` events, so a run that ends while waiting hands it back.
  let counted = false;
  const markWaiting = (on: boolean): void => {
    if (on === counted) return;
    counted = on;
    slots.markWaiting(on ? 1 : -1);
  };
  // Refused past `ai.subagentDepth`: the refusal is returned, the caller words the answer.
  const started = deps.startChild(spec);
  if ('refused' in started) return { refused: started.refused };
  // The run and what is said of its end: the log, the toast. Shared by the slot a run is
  // admitted into and by a stop that takes a child out of the schedule before it began.
  // `later`: a turn of a subagent that stays, after its first answer. Its answer goes up
  // only when the turn read a child's result, and is toasted then as the first answer is;
  // otherwise it stays in the subagent and only the log says it.
  const settle = async (go: () => Promise<ChildResult>, later: boolean): Promise<void> => {
    const failed = (msg: string) => {
      deps.showMessage?.(`⚠ ${label} failed: ${msg}`);
      deps.pushLog?.(`[bg] ${label} error: ${msg}`);
    };
    try {
      const r = await go();
      // Stopped with its conversation (`/clear`, or the exit): only the log says so.
      if (r.stoppedWithParent) { deps.pushLog?.(`[bg] ${label} stopped with its conversation`); return; }
      // Stopped by the person: one line, never also a result toast.
      if (r.outcome === 'stopped') { deps.pushLog?.(`[bg] ${label} stopped`); deps.showMessage?.(`■ ${label} stopped`); return; }
      if (r.outcome === 'failed') { failed(r.error ?? r.outcome); return; }
      // The log says the result without its `<label> finished:` line.
      deps.pushLog?.(`[bg] ${label}: ${childResultBody(r)}`);
      if (later && !r.landedIn) return;
      // Landed nowhere (its conversation was closed first): nothing to point at.
      const home = r.landedIn;
      if (!home) return;
      // The toast is the chat's: it names the session the result went to when that
      // is not the one on screen.
      const where = home.onScreen ? '' : home.title ? ` — in «${home.title}»` : ' — in an untitled session';
      deps.showMessage?.(`⏳ ${label} done${where}`);
    } catch (e) {
      failed(e instanceof Error ? e.message : String(e));
    } finally {
      // A wait counted at the run's end is handed back before the slot frees.
      markWaiting(false);
      // The slot frees once this run settles; the notify waits a tick, so the
      // chat's count it redraws has this task gone.
      if (phase === 'running') phase = 'idle';
      // A message that reached the child while this turn settled starts the next one.
      const next = carried;
      carried = null;
      if (next !== null) begin(next.text, next.turn);
      setTimeout(() => deps.notify?.(), 0);
    }
  };
  // Where the child is in the schedule, for a stop that comes before its run begins.
  // `idle`: a subagent that stays, between its turns; it holds no slot.
  let phase: 'armed' | 'queued' | 'running' | 'idle' = 'armed';
  let dequeue: (() => boolean) | null = null;
  // What the slot runs when the child is admitted: the first run, then each later turn.
  let turn = (): Promise<void> => settle(started.run, false);
  // The message a child sent to itself to answer while its turn was still settling.
  let carried: { text: string; turn?: LaterTurn } | null = null;
  // Counted from the moment it is armed, so the chat's «N in background» shows a
  // task waiting on its delay too; a delayed task holds no slot. The timer runs even
  // with no delay: the turn that called this sends its next request first.
  const timer = setTimeout(() => {
    slots.disarm(timer);
    started.fired();
    phase = 'queued';
    dequeue = slots.admit(async () => { phase = 'running'; await turn(); });
  }, delayMs);
  started.armed(timer);
  // One wait whatever it waits for: a y/n or a question to its parent, both at once count once.
  const waitChanged = (): void => { const w = !!started.child.confirm || !!started.child.parentAsk; if (phase === 'running' || !w) markWaiting(w); };
  started.child.on('confirm', waitChanged);
  started.child.on('ask-parent', waitChanged);
  slots.arm(timer);
  // A stop before the run began takes the child out of the schedule — its timer cleared
  // and its count disarmed, or its place in the queue given up — and settles it at once:
  // its run sends nothing. false when it already runs.
  started.child.delayedUntil = delayMs > 0 ? Date.now() + delayMs : null;
  started.child.leaveSchedule = () => {
    if (phase === 'armed') {
      clearTimeout(timer);
      slots.disarm(timer);
      started.fired();
    } else if (phase !== 'queued' || !dequeue?.()) return false;
    phase = 'running';
    void turn();
    return true;
  };
  // A message to a subagent that stays starts a turn of it: through the same slots as any
  // child, so it waits for one when none is free. One that comes while a turn settles waits
  // for it to finish.
  const again = started.again;
  const begin = (text: string, laterTurn?: LaterTurn): void => {
    if (!again || started.child.closed) return;
    phase = 'queued';
    turn = () => settle(() => again(text, laterTurn), true);
    dequeue = slots.admit(async () => { phase = 'running'; await turn(); });
  };
  if (again) started.child.resume = (text, laterTurn) => { if (phase === 'running') carried = { text, turn: laterTurn }; else begin(text, laterTurn); };
  deps.notify?.();
  return { child: started.child, label };
}
