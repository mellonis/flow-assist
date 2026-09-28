// What the model is told besides the conversation: the system prompt built for each
// message and for each round, and the lines that close, in the model's history, a turn
// that did not finish. Pure but for the memory file, read fresh for every message.
import { chatUser } from '../loader/registry.js';
import { chatLanguage } from './agent.js';
import { memoryPromptBlock, type Fact } from './memory-store.js';
import { describePlan, type TodoItem } from './plan.js';
import { instructionsBlock, type ProjectInstructions } from './project-instructions.js';

// How a turn that did not finish ends in the MODEL's history — an assistant message,
// read as the model's own previous turn. A question left there unanswered was answered
// with the next one: the model went back to what the person had stopped.
export const STOPPED_TURN = '(Stopped by the person before I finished. I am not resuming this request unless they ask me to.)';
// What the model's history says of a turn the host stopped at its limit — `ai.maxRounds`
// or, with `tokens`, `ai.maxTurnTokens`: in the model's voice, where it stopped — so a
// "continue" after it reads as picking up there.
export function roundCapTurn(rounds: number, lastStep?: string, tokens?: number): string {
  const limit = tokens !== undefined ? `${tokens} tokens, its budget for one turn (ai.maxTurnTokens)` : `${rounds} rounds, its limit for one turn (ai.maxRounds)`;
  return `(The host stopped this turn after ${limit}${lastStep ? `; my last step was ${lastStep}` : ''}. The work is not finished: on "continue" I pick up from there.)`;
}
export function failedTurn(message: unknown): string {
  const why = String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `(This turn failed before I could finish${why ? `: ${why}` : ''}.)`;
}

// The «cheap» synchronous base: a directive about the reply (language/
// brevity), who it is answering, a write-language directive. No network — it
// is assembled instantly on every message, so it is not cached.
export function baseStatic(config: Record<string, unknown>): string {
  // Who speaks — the LLM does not know itself: mix in `config.user` (when the
  // person set one) so it addresses a human.
  const who = chatUser(config as { user?: { name?: unknown; login?: unknown } });
  const identity = who
    ? `You are talking to ${who.name}${who.login && who.login !== who.name ? ` (login ${who.login})` : ''}. Address the answer to them, not to an anonymous service account.`
    : '';
  // Between tool calls the model writes prose, because it has nothing else to
  // write there. Asking it not to narrate did not work — it narrated anyway,
  // at whatever length. So it is asked for a SHAPE instead: one short `Next:`
  // line before a call and nothing else — the chat never draws that line
  // (src/assistant/step.ts), so a model that keeps to it leaves nothing but
  // what it did on screen. The final answer is not a step, so the line is
  // asked for before a call only.
  const chatLang = chatLanguage(config.ai as Record<string, unknown>);
  const directive = `Always respond in ${chatLang}. Answer concisely and to the point: only the outcome, and no retelling of your own moves in the final answer. Before you call a tool, write ONE short line that starts with "Next:" and says what you are about to do — nothing else between calls, no plans, no commentary, no repetition of what you already said. Do not begin the final answer with "Next:". Never claim you changed, created or deleted something unless a write tool actually returned success for it; if a write was declined or errored, say so instead. If the user asks why you did not run a tool, or says they do not see its result, do NOT just restate that the tool was already called («it’s already done», «it was scheduled»): actually re-run it now, or ask the user to confirm the repeat («run it again?»). Never claim a result you have not seen returned.`;
  // Write-language directive. The tracker named tracker tools here; the host is
  // tracker-agnostic, so it is generalized to any write/persist tool.
  const writeLangDirective = `When you write or persist content (a write tool: memory, config set/unset, fs, or any tool that writes), write in ${chatLang}.`;
  return [directive, identity, writeLangDirective].filter(Boolean).join('\n\n');
}

// The memory's INDEX for the system prompt — never every fact's text: every
// message reads it again, so a fact added or edited mid-session is in the next
// one. A fact changed outside flow-assist is left out until the person accepts
// it (`/memory accept`). Nothing stored → '' (no block).
// The facts are the conversation's project's and the global ones, as read and marked
// (`markFacts`); one changed outside flow-assist waits for `/memory accept`.
export function memoryBlock(project: readonly Fact[], global: readonly Fact[]): string {
  const kept = (facts: readonly Fact[]) => facts.filter((f) => !f.outside);
  return memoryPromptBlock(kept(project), kept(global));
}

// The CURRENT task plan (the `todo` tool), re-read every message so the model
// sees the live checkboxes it created and must keep in sync. The rendered
// `▾ plan` block only reflects `todo` calls — so this block instructs it to
// route every state change through the tool, never to describe the status in
// prose (the bug it hits: it narrates "42 → done" in chat but the block never
// moves because `todo complete` was never called). Empty → '' (no block).
export function planBlock(plan: readonly TodoItem[]): string {
  if (!plan.length) return '';
  // The plan's own order, by id — the same text the `todo` tool returns.
  return `## Current task plan (the \`todo\` tool)\nYou maintain it through \`todo\`; it changes only when you call the tool. Name an item by its id or its text.\n${describePlan(plan)}`;
}

// The compacted part of the conversation, as the system context carries it —
// read fresh wherever it is used: an automatic compaction mid-turn changes it
// between two rounds of one message.
export const summaryBlock = (summary: string): string =>
  (summary ? `Summary of the conversation so far (older turns were compacted):\n${summary}` : '');

export const projectBlock = (project: ProjectInstructions): string => instructionsBlock(project);

// The system prompt of a message = the «cheap» base (directive+identity) + the
// screens the model can open + fresh memory + the project's instructions + the current plan + the summary. No
// network: the base is synchronous, memory a local file, the instructions read
// when the shell's directory was last set, the plan the tool's module state. It
// is also what the display list keeps as its system message (and so the
// session), which is one reason what the screens show is not in it; the other
// is the cache — it goes at the end of each request instead (`requestTail`,
// `screenNow`). Everything but the instructions and the screens is taken once per
// message (`systemParts`); those two are read again for every round
// (`AgentOpts.systemPrompt`), so a `cd` mid-turn reaches the next round — a
// plan read per round would change the cached prefix after every `todo` call.
export interface SystemParts { base: string; screens: string; memory: string; plan: string; summary: string }
// `screens` is the `## Screens` block as the App's screens service builds it
// (src/runtime/screens.ts, `promptBlock`), '' with nothing to list; `memory` is the block
// as built for this message (the caller reads the facts; reading them may say a note).
// The caller evaluates `screens` before `memory`, the order master's object literal has.
export function systemParts(config: Record<string, unknown>, screens: string, memory: string, plan: readonly TodoItem[], summary: string): SystemParts {
  return { base: baseStatic(config), screens, memory, plan: planBlock(plan), summary: summaryBlock(summary) };
}
export function joinSystem(p: SystemParts, project: string): string | null {
  const parts = [p.base, p.screens, p.memory, project, p.plan, p.summary].filter(Boolean);
  return parts.length ? parts.join('\n\n') : null;
}
