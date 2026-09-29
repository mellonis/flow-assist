// What a conversation is handed by the host it runs in (AGENTS.md, "A conversation has a
// kind"): the chat's, the one-shot's and a test rig's, from one place. Every member reads
// `services()` when it is CALLED: the App rebinds some services on every render, and a
// plugin that joins late is seen.
import { compactConversation } from './agent.js';
import { renderConsole } from './console-view.js';
import type { Conversation } from './conversation.js';
import type { ConversationDeps } from './conversation-types.js';
import type { ContextItem } from './screen-context.js';
import type { ViewRenderers } from './views.js';

export interface DepsSource {
  config: () => Record<string, unknown>;
  // The host's services: the chat's `host.services`, or `createServices(…)` headless.
  services: () => Record<string, unknown>;
  notify: () => void;
  sessionsDir: () => string | null;
  lockToken: string;
  canAsk: boolean;
  pluginToken?: symbol;
  // Tool names every run of the model this conversation makes is not offered — its own
  // turns and each run a tool starts through `ctx.chatLLM` alike.
  withhold?: readonly string[];
  current?: () => Conversation | null | undefined;
}

export function hostDeps(src: DepsSource): ConversationDeps {
  const svc = () => src.services() as Record<string, any>;
  const withhold = src.withhold;
  return {
    config: src.config,
    services: src.services,
    chatLLM: (m, o) => svc().chatLLM(m, withhold?.length ? { ...o, withholdTools: [...withhold, ...(o?.withholdTools ?? [])] } : o),
    compact: compactConversation,
    // The host's own array, spliced in place when a plugin joins late or changes its
    // tools: a turn hands it to `agentChat`, which re-reads the registry every round.
    pluginAiTools: () => svc().pluginAiTools ?? [],
    pluginToken: src.pluginToken,
    viewRenderers: () => (svc().viewRenderers as ViewRenderers | undefined) ?? { console: renderConsole },
    screen: () => { try { return (svc().chatContext as (() => ContextItem[]) | undefined)?.() ?? []; } catch { return []; } },
    afterWrite: () => { void (svc().afterWrite as (() => Promise<void>) | undefined)?.(); },
    notify: src.notify,
    showMessage: (text) => svc().showMessage?.(text),
    pushLog: (line) => svc().pushLog?.(line),
    sessionsDir: src.sessionsDir,
    lockToken: src.lockToken,
    canAsk: src.canAsk,
    screens: () => svc().screens as ReturnType<ConversationDeps['screens']>,
    ...(src.current ? { current: src.current } : {}),
  };
}
