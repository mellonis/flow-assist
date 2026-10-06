// Every conversation a host runs is made here, by one of these (AGENTS.md, "A host makes
// its conversations through one registry"): the chat has one for its life, the one-shot
// one for its run, a test rig one per rig. It holds what is the host's rather than any
// one conversation's: the lock token that makes a session's lock this host's own, what is
// said once for all of them, the conversation the chat draws, and the one exit hook.
import { Conversation } from './conversation.js';
import type { ConfirmPolicy } from './confirm-policy.js';
import { wholeOrDefault } from './rounds.js';
import type { CloseReason, ConversationDeps, ConversationKind, ConversationStatus } from './conversation-types.js';
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
  // One exit hook for the registry (`closeAll('exit')`): whatever happens at exit, every
  // live conversation's last change is written and its lock released, in that order, each
  // task still counted says in its session's journal that it stopped, and all of them
  // close.
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
    if (init.exitHook) this.unhookExit = flushOnExit(() => this.closeAll('exit'));
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

  // ── a session the chat leaves while it has work of its own
  // The open conversation holding session `id`, if one is live here.
  bySession(id: string): Conversation | undefined {
    for (const c of this.convs) if (!c.closed && c.sessionId === id) return c;
    return undefined;
  }
  // How a live session reads to the picker. One held here with nobody drawing it may be
  // running its own turn or waiting for an answer, and its own status says so; with
  // neither it reads `working` while its tasks run, whatever its last answer or result
  // (an unseen one reads `done` from its file once it is put away). Kept here, not in
  // `Conversation.status`, which others read as "a turn runs". null when no
  // conversation here holds it.
  statusOf(id: string): ConversationStatus | null {
    const c = this.bySession(id);
    if (!c) return null;
    const own = c.status;
    return c.children.size && own !== 'waiting' ? 'working' : own;
  }
  // Nothing of its own is left (AGENTS.md (a host makes its conversations through one
  // registry)), clause by clause:
  // - `busy`: a turn, a `!command`, a `!!` ask's hop or a slash command runs;
  // - `children`: a task it started has not delivered its result yet;
  // - `confirm`, `question`: a y/n or a question waits for the person;
  // - `queue`: a message waits for the turn's end. The drain shifts the queue and the turn
  //   it starts sets `busy` in the same synchronous step, so `queue.length || busy` covers
  //   that hop;
  // - `configAsk`: the settings-file ask is in flight. It clears a microtask after its
  //   y/n's answer, and its loop may park the next change before that.
  quiescent(c: Conversation): boolean {
    return !c.busy && c.children.size === 0 && !c.confirm && !c.question && c.queue.length === 0 && !c.configAsk;
  }
  // What parks each conversation kept headless once it is quiescent: one "off" per
  // conversation, dropping every listener of its watch.
  private readonly watches = new Map<Conversation, () => void>();
  // The chat leaves `c` (a switch, `/new`). Quiescent, it is parked now; otherwise it
  // stays loaded, locked and headless — its turn going on, its y/n waiting, its tasks
  // running — and is parked once it is quiescent. Whatever may have ended its work asks
  // for one check, and every check is deferred a macrotask and reads the predicate
  // again: never from inside an `emit` (a park closes the object and clears the handlers
  // the emit is still walking, and `turn-end` comes before what the turn's end starts),
  // and only after what settles a microtask later (the settings ask).
  retire(c: Conversation): 'parked' | 'kept' {
    if (this.quiescent(c)) { this.park(c); return 'parked'; }
    c.headless = true;
    let pending = false;
    const check = (): void => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        if (c.closed || !this.watches.has(c) || !this.quiescent(c)) return;
        this.watches.get(c)?.();
        this.watches.delete(c);
        this.park(c);
      }, 0);
    };
    const offs = [
      c.on('children', check),
      c.on('turn-end', check),
      c.on('confirm', (ev) => { if (!ev.request) check(); }),
      c.on('question', (ev) => { if (!ev.state) check(); }),
    ];
    this.watches.set(c, () => { for (const off of offs) off(); });
    this.notifyChange();
    return 'kept';
  }
  // The chat takes a headless conversation back: its watch is dropped, so it is no
  // longer parked when it comes to rest (a check already deferred finds no watch).
  reclaim(c: Conversation): void {
    this.watches.get(c)?.();
    this.watches.delete(c);
    c.headless = false;
  }
  // A conversation the chat has left, put away: what waits in its inbox lands as rows, it
  // is saved, and only then is its lock released and the object closed — a result that
  // landed in it is in its file before another process may take the session. Only a
  // quiescent one: work going on in a closed conversation would write into an object
  // that saves nothing, so a park asked too early throws instead, and a trigger the
  // watch missed shows as a session never put away.
  park(c: Conversation): void {
    if (c.closed) return;
    if (!this.quiescent(c)) throw new Error('registry.park: the conversation still has work of its own');
    // Lands what waits. Nothing holds the inbox here: the conversation is quiescent, so
    // no turn of its own runs or is about to.
    c.takeInbox('rows');
    c.save({ silent: true });
    c.releaseLock();
    c.close('park');
    this.notifyChange();
  }
  // What reads the registry hears it changed: the host redraws (the footer's count, the
  // picker), then each `onChange` listener runs — each on its own, so one that throws
  // skips neither the redraw nor the others.
  private readonly changeListeners = new Set<() => void>();
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => { this.changeListeners.delete(fn); };
  }
  private notifyChange(): void {
    try { this.init.notify(); } catch { /* a redraw is never fatal */ }
    for (const fn of [...this.changeListeners]) {
      try { fn(); } catch { /* a listener is never fatal */ }
    }
  }

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

  // The process exits: synchronous, like `flushAll`, which it starts with — every live
  // conversation saved and its lock released. Then each task still counted, running or
  // waiting on its delay, writes `task-end … stopped` into its session's journal (through
  // its route's `raw`, the one its filtered route would not carry), so no journal ends
  // mid-task without saying why; and everything closes, deepest first — a task's turn
  // stopped as a parent's stop stops it, so it calls no tool and asks the model nothing
  // after that line (a tool already running finishes, and its `call` line is written).
  // A task still waiting on its delay has its timer cleared and its count disarmed, so it
  // never starts. A task that ends afterwards delivers nowhere and its tool reads it as
  // stopped, not failed (no toast, only the log); no session is parked or saved again (a
  // closed conversation has no listeners, and `park` skips a closed one): its lock is
  // gone by then, and another process may already hold the session.
  closeAll(reason: Extract<CloseReason, 'exit'>): void {
    this.flushAll();
    const deepestFirst: Conversation[] = [];
    const walk = (c: Conversation): void => {
      for (const child of c.children) walk(child);
      deepestFirst.push(c);
    };
    for (const c of [...this.convs]) walk(c);
    for (const c of deepestFirst) {
      if (c.kind !== 'task' || c.closed) continue;
      try { c.journalRoute?.raw({ t: 'task-end', task: c.label, outcome: 'stopped', by: reason }); }
      catch { /* exiting: one journal's failure never skips the others */ }
    }
    for (const c of deepestFirst) {
      for (const [child, timer] of c.childTimers) {
        clearTimeout(timer);
        this.children.disarm(timer);
        c.childTimers.delete(child);
      }
    }
    this.watches.clear();
    // Whatever runs stops with the process, a session's turn or `!command` as well as a
    // task's: an abort kills a command's process group, which would otherwise outlive
    // us. After the save, so the aborted run's `finally` changes nothing that was
    // written; before `close`, which clears the handlers. The stop key names the
    // reason, so the journal and the export say the run stopped at exit, not by Esc; a
    // pending y/n is left as it is (unlike `stop`, which declines it).
    for (const c of deepestFirst) {
      try { if (c.abort) { c.stopKey = reason; c.abort.abort(); } } catch { /* exiting */ }
    }
    for (const c of deepestFirst) {
      try { c.close(reason); } catch { /* exiting */ }
    }
  }
}
