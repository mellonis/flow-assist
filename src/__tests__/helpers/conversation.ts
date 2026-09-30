// A conversation with only the network replaced (AGENTS.md, "Testing"): the host's own
// services (`createServices`) and tool registry, and a sessions directory, a memory
// file, a workspace and a shell root of the test's own — no App. A test sends to it and
// reads what the model was sent, the model's history, the journal and the state file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../../assistant/agent.ts';
import type { ConfirmPolicy } from '../../assistant/confirm-policy.ts';
import { Conversation } from '../../assistant/conversation.ts';
import type { ConversationKind, PendingConfirm, ViewPort } from '../../assistant/conversation-types.ts';
import { readJournal, type JournalEvent } from '../../assistant/journal.ts';
import { firstStart, firstStartPending } from '../../assistant/memory-trust.ts';
import { ConversationRegistry } from '../../assistant/registry.ts';
import { workspaceRoot } from '../../assistant/workspace.ts';
import { acquireLock, journalPath, loadSession, sessionFingerprint, type Session } from '../../assistant/sessions.ts';
import { setStartDirForTests } from '../../assistant/shell.ts';
import { makeFactory, type Make, type Plugin } from '../../loader/plugin.ts';
import { assembleToolRegistry } from '../../loader/tools.ts';
import { createServices } from '../../runtime/services.ts';
import type { ScriptedModel } from './scripted.ts';
import { homeIn, listTree } from './session-files.ts';

export interface RigOptions {
  kind?: ConversationKind;              // 'session' unless said
  policy?: ConfirmPolicy;               // { kind: 'ask' } unless said
  canAsk?: boolean;                     // true unless said
  ai?: Record<string, unknown>;         // over the scripted endpoint and `toolLoading: 'all'`
  shell?: Record<string, unknown>;      // over `roots: [the rig's root]`
  extra?: Record<string, unknown>;      // the rest of the config, as bootApp's `extra`
  guests?: (make: Make) => Plugin[];    // plugins of the test's own, made as the loader makes them
  shown?: boolean;                      // the port shows the conversation's end (true unless said)
  sessions?: boolean;                   // a sessions directory of the test's own (true unless said)
  inbox?: boolean;                      // `services.postToChat` delivers to `rig.conv`, as the chat binds it (false unless said)
}

// What a chat's view answers when the conversation asks: its end shown or not, the field empty.
export class FakePort implements ViewPort {
  constructor(public shown = true) {}
  showsEnd(): boolean { return this.shown; }
  open(): boolean { return this.shown; }
  input(): string { return ''; }
  draft(): string { return ''; }
}

// A message as a request carried it.
export type Sent = ChatMessage & { tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };

export type Rig = ReturnType<typeof conversationRig>;

// Every conversation a rig made since the last `closeRigs`, every rig's registry, and the
// LLM_TOKEN the first of them found.
const made: Conversation[] = [];
const registries: ConversationRegistry[] = [];
let tokenBefore: { value: string | undefined } | null = null;

// Cancels every background task still waiting on its delay, closes every conversation a
// rig made (their timers go, the 250 ms save among them) and puts LLM_TOKEN back as it
// was. A rig test file calls it in its `afterEach`.
export function closeRigs(): void {
  for (const r of registries.splice(0)) r.children.cancelArmed();
  for (const c of made.splice(0)) c.close('exit');
  if (!tokenBefore) return;
  if (tokenBefore.value === undefined) delete process.env.LLM_TOKEN; else process.env.LLM_TOKEN = tokenBefore.value;
  tokenBefore = null;
}

export function conversationRig(model: ScriptedModel, opts: RigOptions = {}) {
  tokenBefore ??= { value: process.env.LLM_TOKEN };
  process.env.LLM_TOKEN = '^scripted-llm-token';
  model.install();
  // By their real paths: the shell compares roots by it, and the temporary directory may
  // be a symbolic link (macOS).
  const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const root = tmp('fa-rig-root-');
  const sessionsDir = opts.sessions === false ? null : tmp('fa-rig-sessions-');
  const config: Record<string, unknown> = {
    ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all', ...opts.ai },
    ...(sessionsDir ? { sessions: { dir: sessionsDir } } : {}),
    memory: { file: path.join(tmp('fa-rig-memory-'), 'memory.json') },
    workspace: { dir: tmp('fa-rig-workspace-') },
    shell: { roots: [root], ...opts.shell },
    ...opts.extra,
  };
  const repo = { enabledPlugins: async () => [], list: async () => [] } as never;
  const plugins = opts.guests ? opts.guests(makeFactory(config as never)) : [];
  const tools = assembleToolRegistry({ plugins, config, repo });
  const services = createServices({ config, tools, repo, onExit: () => {} });
  const toasts: string[] = [];
  const log: string[] = [];
  services.showMessage = (text) => { toasts.push(text); };
  services.pushLog = (line) => { log.push(line); };
  // The memory's first-start pass, as the chat runs it when it opens: without it every
  // turn says the record is missing, in a note row (and a journal line) of its own.
  if (firstStartPending()) firstStart(workspaceRoot(config));
  // The rig's conversations are made as the chat makes its own: through a registry,
  // one per rig, on the host's real services.
  const registry = new ConversationRegistry({
    config: () => config,
    services: () => services as unknown as Record<string, unknown>,
    notify: () => {},
    sessionsDir: () => sessionsDir,
    canAsk: opts.canAsk ?? true,
  });
  registries.push(registry);
  const deps = registry.deps();
  const port = new FakePort(opts.shown ?? true);
  const init = { kind: opts.kind ?? 'session', policy: opts.policy ?? { kind: 'ask' } };
  // The shell starts in the rig's root, as bootApp starts the chat's in its first root;
  // the start directory is read when the shell is made, and reset at once.
  const attached = (make: () => Conversation): Conversation => {
    setStartDirForTests(root);
    try { const c = make(); made.push(c); c.attach(port); return c; } finally { setStartDirForTests(null); }
  };
  const homeOf = (id: string) => homeIn(sessionsDir!, id);
  let conv = attached(() => registry.fresh(init));

  const rig = {
    get conv(): Conversation { return conv; },
    model, config, services, deps, registry, root, sessionsDir, port, toasts, log,
    requests: model.requests,
    // The messages request `i` sent (the last one by default), the system message left out.
    sent(i = -1): Sent[] { return ((model.requests.at(i)?.messages ?? []) as Sent[]).filter((m) => m.role !== 'system'); },
    // Request `i`'s messages whole, the system message included.
    messages(i: number): Sent[] { return (model.requests.at(i)?.messages ?? []) as Sent[]; },
    // Another conversation on the same host, as `/new` makes one; it becomes `rig.conv`.
    fresh(): Conversation { conv = attached(() => registry.fresh(init)); return conv; },
    // A saved session opened as the chat opens one — the fingerprint, then the file, then
    // the lock — into a conversation of its own; it becomes `rig.conv`.
    open(id: string): Conversation {
      const dir = homeOf(id);
      const fingerprint = sessionFingerprint(dir, id);
      const session = loadSession(dir, id);
      if (!session) throw new Error(`rig.open: no readable session ${id} under ${sessionsDir}`);
      acquireLock(dir, id, registry.lockToken);
      conv = attached(() => registry.restore(session, fingerprint, dir, { policy: init.policy }));
      return conv;
    },
    // Every journal / state file under the sessions directory, as paths relative to it.
    journals(): string[] { return sessionsDir ? listTree(sessionsDir).filter((n) => n.endsWith('.log.jsonl')) : []; },
    stateFiles(): string[] { return sessionsDir ? listTree(sessionsDir).filter((n) => n.endsWith('.json')) : []; },
    // A session's journal (this conversation's by default); [] with none.
    journal(id = conv.sessionId): JournalEvent[] {
      if (!sessionsDir || !id) return [];
      return readJournal(journalPath(homeOf(id), id)) ?? [];
    },
    // A session's state file as a start reads it; null with none.
    sessionFile(id = conv.sessionId): Session | null { return sessionsDir && id ? loadSession(homeOf(id), id) : null; },
    // Waits, a few milliseconds at a time, until `ok()` holds; fails after `ms`.
    async until(ok: () => boolean, ms = 10_000): Promise<void> {
      const end = Date.now() + ms;
      while (!ok()) {
        if (Date.now() > end) throw new Error('rig.until: the condition never held');
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    // Until nothing runs, and what the end of work sends from a zero-delay timer has gone.
    async idle(): Promise<void> {
      await rig.until(() => !conv.busy);
      await new Promise((r) => setTimeout(r, 10));
      await rig.until(() => !conv.busy);
    },
    // The y/n waiting for the person, as the chat would draw it; null with none.
    pending(): PendingConfirm | null { return conv.confirmDrawn; },
    // Answers it, as the person's key does.
    answerNext(ok: boolean): void {
      if (!conv.confirm) throw new Error('rig.answerNext: nothing waits for an answer');
      conv.answerConfirm(ok);
    },
    // The conversation's timers go (the 250 ms save among them), as at exit.
    close(): void { conv.close('exit'); },
  };
  // A background task's result, delivered as the chat delivers it: into the conversation
  // the rig holds when the task ends.
  if (opts.inbox) (services as unknown as { postToChat: (text: string) => void }).postToChat = (text) => rig.conv.deliver(text);
  return rig;
}
