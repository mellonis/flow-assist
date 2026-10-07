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
  // Refused past `ai.subagentDepth`: the refusal is returned, the caller words the answer.
  const started = deps.startChild(spec);
  if ('refused' in started) return { refused: started.refused };
  // Counted from the moment it is armed, so the chat's «N in background» shows a
  // task waiting on its delay too; a delayed task holds no slot. The timer runs even
  // with no delay: the turn that called this sends its next request first.
  const timer = setTimeout(() => {
    slots.disarm(timer);
    started.fired();
    slots.admit(async () => {
      const failed = (msg: string) => {
        deps.showMessage?.(`⚠ ${label} failed: ${msg}`);
        deps.pushLog?.(`[bg] ${label} error: ${msg}`);
      };
      try {
        const r = await started.run();
        // Stopped with its conversation (`/clear`, or the exit): only the log says so.
        if (r.stoppedWithParent) { deps.pushLog?.(`[bg] ${label} stopped with its conversation`); return; }
        if (r.outcome === 'failed' || r.outcome === 'stopped') { failed(r.error ?? r.outcome); return; }
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
        // The slot frees once this run settles; the notify waits a tick, so the
        // chat's count it redraws has this task gone.
        setTimeout(() => deps.notify?.(), 0);
      }
    });
  }, delayMs);
  started.armed(timer);
  slots.arm(timer);
  deps.notify?.();
  return { child: started.child, label };
}
