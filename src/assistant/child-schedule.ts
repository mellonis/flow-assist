// The schedule of a child conversation: start it, arm its delay, and when the delay ends
// admit its run into a slot and report how it ended (AGENTS.md (child schedule)). The
// `subagent` tool and any caller outside a turn share it, so the order is one:
// start → timer → disarm → fired → admit → run → log / toast → notify.
import { childResultBody, type ChildSpec, type ChildStart } from './conversation-types.js';
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
  // that parks a y/n gives its slot up until the answer; the count is kept here, from the
  // child's own `confirm` events, so a run that ends while waiting hands it back.
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
  const settle = async (): Promise<void> => {
    const failed = (msg: string) => {
      deps.showMessage?.(`⚠ ${label} failed: ${msg}`);
      deps.pushLog?.(`[bg] ${label} error: ${msg}`);
    };
    try {
      const r = await started.run();
      // Stopped with its conversation (`/clear`, or the exit): only the log says so.
      if (r.stoppedWithParent) { deps.pushLog?.(`[bg] ${label} stopped with its conversation`); return; }
      // Stopped by the person: one line, never also a result toast.
      if (r.outcome === 'stopped') { deps.pushLog?.(`[bg] ${label} stopped`); deps.showMessage?.(`■ ${label} stopped`); return; }
      if (r.outcome === 'failed') { failed(r.error ?? r.outcome); return; }
      // The log says the result without its `<label> finished:` line.
      deps.pushLog?.(`[bg] ${label}: ${childResultBody(r)}`);
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
      setTimeout(() => deps.notify?.(), 0);
    }
  };
  // Where the child is in the schedule, for a stop that comes before its run begins.
  let phase: 'armed' | 'queued' | 'running' = 'armed';
  let dequeue: (() => boolean) | null = null;
  // Counted from the moment it is armed, so the chat's «N in background» shows a
  // task waiting on its delay too; a delayed task holds no slot. The timer runs even
  // with no delay: the turn that called this sends its next request first.
  const timer = setTimeout(() => {
    slots.disarm(timer);
    started.fired();
    phase = 'queued';
    dequeue = slots.admit(async () => { phase = 'running'; await settle(); });
  }, delayMs);
  started.armed(timer);
  started.child.on('confirm', (ev) => { if (phase === 'running' || !ev.request) markWaiting(!!ev.request); });
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
    void settle();
    return true;
  };
  deps.notify?.();
  return { child: started.child, label };
}
