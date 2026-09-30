// The vocabulary of a conversation: what the chat draws (`ChatMsg`), what waits, what
// runs, what the chat is told, and what a conversation needs from the host and the chat.
import type { AgentOpts, AgentResult, ChatMessage } from './agent.js';
import type { AskState } from './ask.js';
import type { AutoMode } from './auto.js';
import type { ContextItem } from './screen-context.js';
import type { TurnPart } from './step.js';
import type { ViewRecord, ViewRenderers } from './views.js';
import type { Conversation } from './conversation.js';

// A chat message. `role` is the OpenAI role; `content` may be null when a message
// carries tool_calls. Extra fields ride along (live/reasoning/parts/duration/…).
export interface ChatMsg {
  role: string;
  content?: string | null;
  // The round being written now, and whether it is known to carry a tool call — then
  // it is a step, not the answer (src/assistant/step.ts).
  live?: string;
  liveQuiet?: boolean;
  reasoning?: string;
  // The turn so far in the order it happened: the steps (the text of each round that
  // went on to call a tool) and the changes its writes reported. Display only.
  parts?: TurnPart[];
  duration?: number;
  stopped?: boolean;
  // A block a tool asked the host to draw (role 'view') — a command's output so far.
  views?: ViewRecord[];
  // The call a DISCARDED view belonged to — kept on the message so a later final for
  // the same call still finds it (ids are places among drawn messages; removing the
  // message would move every fold id after it).
  discardedCallId?: string;
  [k: string]: unknown;
}

// A message the person sent while something ran, and whether ⇥ held it to the turn's end.
export type Queued = { text: string; hold?: boolean };
// When a queued message reaches the model in a running turn (`Conversation.queueWait`).
export type QueueWait = 'step' | 'end' | 'image' | 'behind';

// The message this turn's answer is being written into: the last assistant message the
// turn has not yet stamped with its duration. It is looked up rather than assumed
// to be the last one, because a tool's view (a command's output) is a message of its
// own and may well sit after it — and the turn's seconds and what it cost belong on
// the answer whatever landed below it. −1 when the turn has no answer message yet.
export function answerAt(list: ChatMsg[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!;
    if (m.role === 'assistant' && m.duration == null) return i;
  }
  return -1;
}

// The last answer in a list: the last assistant message with text, as a string — what
// `/copy` takes (src/assistant/copy.ts) and what the one-shot prints. '' with none.
export function lastAnswerOf(list: readonly { role?: string; content?: unknown }[]): string {
  const a = list.findLast((m) => m.role === 'assistant' && String(m.content ?? '').trim());
  return a ? String(a.content) : '';
}

// The call a message's view belongs to — a live one, or a discarded one's.
export const callOf = (m: ChatMsg): string | undefined => (m.views as ViewRecord[] | undefined)?.[0]?.callId ?? m.discardedCallId;

// 'session': a chat's — saved, journaled, locked, continued. 'oneshot': `flow-assist
// "<prompt>"` — nobody to ask, no screen, no journal, no session file. Children come later.
export type ConversationKind = 'session' | 'task' | 'oneshot';
export type BusyKind = 'turn' | 'shell' | 'interactive' | 'command';
export type ConversationStatus = 'working' | 'waiting' | 'done' | 'idle';
export type CloseReason = 'clear' | 'new' | 'park' | 'exit';

// What runs now, as the status line draws it. Kept after the work ends, as the chat's
// state was: the next start resets each field. (The seconds are the chat's own ticker,
// which reads `Conversation.segmentStartedAt`.)
export interface Activity {
  label: string;                 // '⚙ read_file(…)…', '$ bun test', '⚙ compact…', '' for the model's own round
  phase: 'thinking' | 'writing';
  verb: string;                  // the gerund picked per request (verbs.ts)
  toolCount: number;
  turnTokens: number;
}

// How a piece of work ended. `done`: a `!command` or `/compact` that ran to its end.
export interface TurnEnd {
  kind: BusyKind;
  outcome: 'answer' | 'empty' | 'limit' | 'stopped' | 'failed' | 'done';
  stoppedBy?: string;            // the key glyph that stopped it: 'Esc', '^c'
  error?: string;
  limit?: { rounds: number; lastStep: string; by?: 'tokens'; turnTokens?: number };
  ms: number;
  tokens?: number;
  cached?: number;
}

// A y/n waiting on a write, as the block draws it — or the settings-file guard's own y/n
// (`name: 'config'`), which brings its own title, hint and whole-text flag.
export interface PendingConfirm { name: string; args: string; command?: string; line?: string; input?: string; title?: string; hint?: string; whole?: boolean }

export interface SendOptions {
  hostAsk?: boolean;             // the host's ask after a `!!command`: drawn dim, never in ↑/↓
  fromInbox?: boolean;           // the inbox's follow-up turn (`ai.backgroundFollowUp`, on unless set false): role `bg`, never in ↑/↓, the field and its history walk left alone
}

// What a chat draws of a conversation (`Conversation.getSnapshot`). The same object until
// `version` moves.
export interface ConversationSnapshot {
  readonly version: number;
  readonly key: string;
  readonly kind: ConversationKind;
  readonly messages: readonly ChatMsg[];
  readonly busy: BusyKind | null;
  readonly activity: Activity;
  readonly pendingConfirm: PendingConfirm | null;
  readonly pendingQuestion: AskState | null;
  readonly queued: readonly Queued[];
  readonly autoMode: AutoMode;
  readonly continueOffer: boolean;
  readonly emptyAnswer: boolean; // the last turn ended with reasoning and no final text
}

// Typed events: fired synchronously, in the order the work does things.
export type ConversationEvent =
  | { type: 'turn-start'; kind: BusyKind; label: string; hostAsk?: boolean; fromInbox?: boolean }
  | { type: 'turn-end'; end: TurnEnd }
  | { type: 'activity' }          // a new segment began: the chat's seconds start again from 0
  | { type: 'confirm'; request: PendingConfirm | null }
  | { type: 'question'; state: AskState | null; parked?: boolean }
  | { type: 'notice'; text: string; level: 'error' }
  | { type: 'inbox'; items: string[]; shown: boolean }   // every item that landed together; `shown`: the chat is open
  | { type: 'closed'; reason: CloseReason };

// What a conversation asks of the chat that draws it: reads only.
export interface ViewPort {
  showsEnd(): boolean;           // the chat open, and neither the picker, the pager nor a plugin's panel in its place
  open(): boolean;               // the chat open (an inbox landing while it is closed is unread)
  input(): string;               // the field as typed
  draft(): string;               // the field as a session keeps it ('' for a /command, a !command, a bang level)
}

// What a conversation needs from the host. Every member is read when it is used: the
// App rebinds some services on every render.
export interface ConversationDeps {
  config: () => Record<string, unknown>;
  services: () => Record<string, unknown>;
  chatLLM: (messages: ChatMessage[], opts: AgentOpts) => Promise<AgentResult>;
  compact: typeof import('./agent.js').compactConversation;
  pluginAiTools: () => unknown[];
  pluginToken: symbol | undefined;
  viewRenderers: () => ViewRenderers;
  screen: () => ContextItem[];
  afterWrite: () => void;
  notify: () => void;
  showMessage: (text: string) => void;
  pushLog: (line: string) => void;
  sessionsDir: () => string | null;
  lockToken: string;
  // A person is there to answer a y/n or a question. A conversation whose policy is
  // `ask` cannot be made where this is false, and the settings-file guard never asks
  // where it is false.
  canAsk: boolean;
  // What is said once for every conversation of a host, not once per conversation: the
  // missing memory record. Absent: the conversation keeps its own.
  said?: { memoryMissing: boolean };
  // The App's screens service (src/runtime/screens.ts): the system prompt's `## Screens`
  // block, and the end of work that opens what a turn held back. Undefined with no App.
  screens: () => { promptBlock(): string; afterTurn(ok: boolean): void } | undefined;
  // The conversation the chat draws now, where work that outlived a closed one asks
  // what it must ask the person. Undefined with no chat.
  current?: () => Conversation | null | undefined;
}
