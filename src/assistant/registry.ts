// Every conversation a host runs is made here, by one of these (AGENTS.md, "A host makes
// its conversations through one registry"): the chat has one for its life, the one-shot
// one for its run, a test rig one per rig. It holds what is the host's rather than any
// one conversation's: the lock token that makes a session's lock this host's own, what is
// said once for all of them, the conversation the chat draws, and the one exit hook.
import { Conversation } from './conversation.js';
import type { ConfirmPolicy } from './confirm-policy.js';
import type { ConversationDeps, ConversationKind } from './conversation-types.js';
import { hostDeps, type DepsSource } from './host-deps.js';
import { flushOnExit, makeLockToken, type Session, type SessionFingerprint } from './sessions.js';

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
  private unhookExit: (() => void) | null = null;

  constructor(private readonly init: RegistryInit) {
    this.canAsk = init.canAsk;
    if (init.exitHook) this.unhookExit = flushOnExit(() => this.flushAll());
  }

  // What a conversation of this host is handed; `current` is the one the chat draws.
  deps(): ConversationDeps {
    const { exitHook: _exitHook, ...src } = this.init;
    return { ...hostDeps({ ...src, lockToken: this.lockToken, current: () => this.onScreen }), said: this.said };
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
  show(c: Conversation): void { this.onScreen = c; }
  shown(): Conversation | null { return this.onScreen; }

  // Synchronous — it runs from `process.on('exit')` too. Every live conversation's last
  // change is written (silently) and its lock released after that save. Nothing is
  // closed: work still in flight goes on writing into the conversation it ran in.
  flushAll(): void {
    this.unhookExit?.();
    this.unhookExit = null;
    for (const c of [...this.convs]) {
      c.save({ silent: true });
      c.releaseLock();
    }
  }
}
