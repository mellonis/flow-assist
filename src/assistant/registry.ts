// Every conversation a host runs is made here, by one of these (AGENTS.md, "A host makes
// its conversations through one registry"): the chat has one for its life, the one-shot
// one for its run, a test rig one per rig. It holds what is the host's rather than any
// one conversation's: the lock token that makes a session's lock this host's own, what is
// said once for all of them, the conversation the chat draws, and the one exit hook.
import { Conversation } from './conversation.js';
import type { ConfirmPolicy } from './confirm-policy.js';
import { wholeOrDefault } from './rounds.js';
import type { ConversationDeps, ConversationKind, ConversationStatus } from './conversation-types.js';
import { hostDeps, type DepsSource } from './host-deps.js';
import { flushOnExit, makeLockToken, type Session, type SessionFingerprint } from './sessions.js';

// The host's bookkeeping for background tasks, shared by every conversation it makes
// (AGENTS.md, "A host makes its conversations through one registry").
export interface ChildSlots {
  // A task counted from the moment it is armed (its delay starts): what `N in background`
  // shows. `timer` is the delay's handle, kept so `cancelArmed` can stop a task that has
  // not started.
  arm(timer?: ReturnType<typeof setTimeout>): void;
  // An armed task that starts, ends, or never starts.
  disarm(timer?: ReturnType<typeof setTimeout>): void;
  // Clears every armed task that has not started yet: its timer and its count.
  cancelArmed(): void;
  // Runs `run` now when a slot is free, else queues it (FIFO); the slot frees when `run` settles.
  admit(run: () => Promise<void>): void;
  // Armed + queued + running.
  backgroundCount(): number;
  // Running only.
  running(): number;
}

export interface RegistryInit extends Omit<DepsSource, 'lockToken' | 'current'> {
  // One exit hook for the registry: whatever happens at exit, every live conversation's
  // last change is written and its lock released, in that order.
  exitHook?: boolean;
}

export class ConversationRegistry {
  // One for the host's whole life: what makes a lock this host's own (sessions.ts,
  // "Ownership lock").
  readonly lockToken = makeLockToken();
  readonly canAsk: boolean;
  private readonly said = { memoryMissing: false };
  private readonly convs = new Set<Conversation>();
  private onScreen: Conversation | null = null;
  // Tasks run at most `max(1, sessions.maxRunning - 1)` at a time (default 4, so three): a
  // session's own turn keeps the slot the count leaves it and never waits on a task.
  readonly children: ChildSlots = this.makeSlots();
  private unhookExit: (() => void) | null = null;

  constructor(private readonly init: RegistryInit) {
    this.canAsk = init.canAsk;
    if (init.exitHook) this.unhookExit = flushOnExit(() => this.flushAll());
  }

  private makeSlots(): ChildSlots {
    let armed = 0;
    let running = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const queue: Array<() => Promise<void>> = [];
    const limit = (): number => {
      const sessions = this.init.config().sessions as { maxRunning?: unknown } | undefined;
      return Math.max(1, wholeOrDefault(sessions?.maxRunning, 4, 2) - 1);
    };
    const start = (run: () => Promise<void>): void => {
      running++;
      const done = (): void => {
        running--;
        const next = queue.shift();
        if (next && running < limit()) start(next);
        else if (next) queue.unshift(next);
      };
      let p: Promise<void>;
      try { p = run(); } catch (e) { p = Promise.reject(e); }
      p.then(done, done);
    };
    return {
      arm: (timer) => { armed++; if (timer !== undefined) timers.add(timer); },
      disarm: (timer) => { armed = Math.max(0, armed - 1); if (timer !== undefined) timers.delete(timer); },
      cancelArmed: () => {
        for (const t of timers) clearTimeout(t);
        armed = Math.max(0, armed - timers.size);
        timers.clear();
      },
      admit: (run) => { if (running < limit()) start(run); else queue.push(run); },
      backgroundCount: () => armed + queue.length + running,
      running: () => running,
    };
  }

  // What a conversation of this host is handed; `current` is the one the chat draws.
  deps(): ConversationDeps {
    const { exitHook: _exitHook, ...src } = this.init;
    return { ...hostDeps({ ...src, lockToken: this.lockToken, current: () => this.onScreen }), said: this.said, children: this.children };
  }

  private track(c: Conversation): Conversation {
    this.convs.add(c);
    c.on('closed', () => {
      this.convs.delete(c);
      if (this.onScreen === c) this.onScreen = null;
    });
    return c;
  }

  // A conversation that replaces another in the chat, with what it carries over.
  create(carry: ConstructorParameters<typeof Conversation>[1] = {}): Conversation {
    return this.track(new Conversation(this.deps(), carry));
  }
  // A new conversation as a driver starts one (`Conversation.fresh`).
  fresh(init: { kind: ConversationKind; policy: ConfirmPolicy }): Conversation {
    return this.track(Conversation.fresh(this.deps(), init));
  }
  // A saved session, opened into a conversation of its own (`Conversation.restore`). The
  // caller took the fingerprint before it read the session, and holds its lock.
  restore(session: Session, fingerprint: SessionFingerprint, dir: string, init?: { policy: ConfirmPolicy }): Conversation {
    return this.track(Conversation.restore(this.deps(), session, fingerprint, dir, init));
  }

  live(): readonly Conversation[] { return [...this.convs]; }

  // ── a session the chat leaves while its tasks run
  // The open conversation holding session `id`, if one is live here.
  bySession(id: string): Conversation | undefined {
    for (const c of this.convs) if (!c.closed && c.sessionId === id) return c;
    return undefined;
  }
  // How a live session reads to the picker: its own status, but `working` while it is
  // idle and its tasks run — kept here, not in `Conversation.status`, which others read
  // as "a turn runs". null when no conversation here holds it.
  statusOf(id: string): ConversationStatus | null {
    const c = this.bySession(id);
    if (!c) return null;
    const own = c.status;
    return own === 'idle' && c.children.size ? 'working' : own;
  }
  // What parks each conversation kept headless when its last task ends.
  private readonly watches = new Map<Conversation, () => void>();
  // The chat leaves `c` (a switch, `/new`). With no task of its own left it is parked
  // now; otherwise it stays loaded, locked and headless, and is parked once its last
  // task's result has landed in it.
  retire(c: Conversation): 'parked' | 'kept' {
    if (!c.children.size) { this.park(c); return 'parked'; }
    c.headless = true;
    const off = c.on('children', (ev) => {
      if (ev.count) return;
      this.watches.delete(c);
      off();
      this.park(c);
    });
    this.watches.set(c, off);
    this.notifyChange();
    return 'kept';
  }
  // The chat takes a headless conversation back: it is no longer parked when its tasks end.
  reclaim(c: Conversation): void {
    this.watches.get(c)?.();
    this.watches.delete(c);
    c.headless = false;
  }
  // A conversation the chat has left, put away: what waits in its inbox lands as rows, it
  // is saved, and only then is its lock released and the object closed — a result that
  // landed in it is in its file before another process may take the session.
  park(c: Conversation): void {
    if (c.closed) return;
    // Lands what waits. Nothing holds the inbox here: the chat leaves a conversation only
    // while nothing of its own runs, and one left runs no turn of its own.
    c.takeInbox('rows');
    c.save({ silent: true });
    c.releaseLock();
    c.close('park');
    this.notifyChange();
  }
  // The chat redraws what reads the registry (the footer's count, the picker).
  private notifyChange(): void { try { this.init.notify(); } catch { /* a redraw is never fatal */ } }

  show(c: Conversation): void { this.onScreen = c; }
  shown(): Conversation | null { return this.onScreen; }

  // Synchronous — it runs from `process.on('exit')` too. Every live conversation's last
  // change is written (silently) and its lock released after that save. Nothing is
  // closed: work still in flight goes on writing into the conversation it ran in.
  flushAll(): void {
    this.unhookExit?.();
    this.unhookExit = null;
    for (const c of [...this.convs]) {
      try {
        c.save({ silent: true });
        c.releaseLock();
      } catch { /* exiting: one conversation's failure never skips the others */ }
    }
  }
}
