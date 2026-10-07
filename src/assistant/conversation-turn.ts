// A conversation's work: a turn with the model, `/compact`, the y/n a write waits on and
// the settings-file guard's own. Functions over a Conversation, which holds the state;
// its methods call them, and the chat answers their events (AGENTS.md, "The chat").
import path from 'node:path';
import { transcriptSoFar, type ChatMessage, type compactConversation, type TokenUsage, type ToolRun } from './agent.js';
import type { AskQuestion } from './ask.js';
import { RESUMED_NOTE, autoCompactLimits, overThreshold } from './compaction.js';
import { confirmFor } from './confirm-policy.js';
import { estimateTokens, short as shortTokens } from './context-meter.js';
import { imagesInText, isImageRefusal, wireMessages, type ImageRef } from './images.js';
import { callEndEvent, callStartEvent, outputJournal } from './journal.js';
import { llmOpts } from './llm-endpoint.js';
import { pushHistory } from './prompt-history.js';
import { decideBatch, recallLimits, type RecallSource } from './recall.js';
import { screenBlock } from './screen-context.js';
import { addCalls, callRun, endRound, startsWithNext, type CallRun, type TurnPart } from './step.js';
import { STOPPED_TURN, failedTurn, joinSystem, languageDirective, projectBlock, roundCapTurn, summaryBlock, systemParts } from './system-prompt.js';
import type { ViewRecord } from './views.js';
import type { ToolDef } from '../loader/tools.js';
import { RESTART_NOTE, type ConfigChange } from '../config/load.js';
import { keyGlyph } from '../playback/keys.js';
import { answerAt, type ChatMsg, type ChildSpec, type ConversationKind, type SendOptions } from './conversation-types.js';
import type { Conversation } from './conversation.js';

// A plain object holding every enumerable service, inherited ones included.
// `for…in` walks the prototype chain, which is exactly what a spread does not.
export function allServices(services: object): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const key in services) flat[key] = (services as Record<string, unknown>)[key];
  return flat;
}

// What a turn is handed that differs by the kind of conversation it runs in. A chat's
// session gets the person's screens as each request's tail, the round boundary (the
// queue, the settings-file guard, the automatic compaction), recall and `ask_user`, and
// withholds nothing. The one-shot prompt has none of them, and is not offered the tools
// that have nothing to deliver to without the app (AGENTS.md, "CLI").
export interface TurnShape {
  // 'chat': the person's system prompt (directive, identity, memory, plan, summary, screens,
  // project). 'worker': the background worker's prompt with the task in it, plus the project
  // block, read again every round. 'subagent': the worker's prompt with the person's task
  // framed as theirs, the memory block and the language directive, plus the project block
  // and the conversation's own summary, both read again every round.
  system: 'chat' | 'worker' | 'subagent';
  screen: boolean;
  boundary: boolean;
  recall: boolean;
  askUser: boolean;
  images: boolean;
  // A cap on the rounds of a turn, over the config's `ai.maxRounds`.
  maxRounds?: number;
  withholdTools: readonly string[];
}
export const ONESHOT_WITHHELD: readonly string[] = ['subagent', 'remind'];
export const TASK_ROUNDS = 12;
export const SUBAGENT_WITHHELD: readonly string[] = ['remind'];
const SHAPES: Record<ConversationKind, TurnShape> = {
  session: { system: 'chat', screen: true, boundary: true, recall: true, askUser: true, images: true, withholdTools: [] },
  task: { system: 'worker', screen: false, boundary: false, recall: false, askUser: false, images: false, maxRounds: TASK_ROUNDS, withholdTools: [] },
  subagent: { system: 'subagent', screen: false, boundary: true, recall: true, askUser: false, images: false, withholdTools: SUBAGENT_WITHHELD },
  oneshot: { system: 'chat', screen: false, boundary: false, recall: false, askUser: false, images: true, withholdTools: ONESHOT_WITHHELD },
};
export function turnShape(kind: ConversationKind): TurnShape {
  return SHAPES[kind];
}

// The system prompt of a background worker, with its task.
const WORKER_PROMPT = 'You are a background worker. Complete the task below autonomously using the available tools, then return ONLY a concise result (a few sentences). Do not ask questions or wait for the user — act. You may spawn a follow-up `subagent` task if the work needs a further step (e.g. "build, then fix and rebuild on failure"), but keep the chain at most ONE level and only if it is genuinely needed. IMPORTANT: if the task asks for the current time, date, weekday, or a relative duration, you MUST call the `datetime` tool to get it (never answer from memory — it will be stale).\n\n';
export function workerPrompt(task: string): string {
  return `${WORKER_PROMPT}Task: ${task}`;
}
// The same worker prompt for a subagent: the task is the person's own, framed as that.
export function subagentPrompt(task: string): string {
  return `${WORKER_PROMPT}The person's task: ${task}`;
}

// `hostAsk`: the text is the HOST's request, sent as the person's message (after
// an interactive `!!command`, "look at what it printed") — drawn as the host's,
// never kept in ↑/↓.
export async function runTurn(c: Conversation, text: string, opts: SendOptions = {}): Promise<boolean> {
  const q = text.trim();
  if (!q || c.busy) return false;
  // Close the re-entrancy window SYNCHRONOUSLY, before any await: send() is
  // called from the input handler, the inbox, and the slash command. Without
  // this, a follow-up turn for the inbox started while the chat is about to go
  // idle could double-fire.
  c.busy = true;
  c.busyKind = 'turn';
  const cfg = c.deps.config();
  const shape = turnShape(c.kind);
  // System context is assembled WITHOUT network on every message: replace the
  // old (role system) with a fresh one where memory is current (directive+
  // identity+memory). The chat history (user/assistant) is kept.
  // The screens are read first, then the memory (reading it may say a note).
  // A worker reads no screens and no memory: its prompt is the task, the project's
  // instructions after it (`TurnShape.system`).
  const sysParts = shape.system === 'chat' ? systemParts(cfg, c.screensBlock(), c.memoryBlock(), c.plan.snapshot(), c.summary) : undefined;
  const chatSystem = (parts: ReturnType<typeof systemParts>, fresh: boolean) =>
    joinSystem(fresh ? { ...parts, screens: c.screensBlock(), summary: summaryBlock(c.summary) } : parts, projectBlock(c.project));
  // A subagent's memory block is read once for the message, as a chat's is.
  const subagentHead = shape.system === 'subagent' ? [subagentPrompt(q), c.memoryBlock(), languageDirective(cfg)].filter(Boolean).join('\n\n') : '';
  const workerSystem = () => shape.system === 'subagent'
    ? [subagentHead, projectBlock(c.project), summaryBlock(c.summary)].filter(Boolean).join('\n\n')
    : [workerPrompt(q), projectBlock(c.project)].filter(Boolean).join('\n\n');
  const sys = sysParts ? chatSystem(sysParts, false) : workerSystem();
  // DISPLAY source vs LLM role are split: a background result stays role 'bg'
  // on screen and in the kept history (it is NOT the person's own message), while
  // for the model it is still a prompt to answer — `apiHistory` maps 'bg' →
  // 'user', framed by its own `<label> finished:` line.
  // Every bulky item a batch has stubbed goes as its stub (src/assistant/
  // recall.ts); what this turn adds — the question's images, a `!command` run
  // since the last turn — is not in the set yet and goes in full.
  const apiMsgs: ChatMessage[] = c.sentHistory();
  c.recall.recalled = new Set(); // what `recall` brings back is this turn's
  // What this message ADDS to the screen list; laid onto the list as it is when
  // React applies it (below), never onto what was last drawn.
  const added: ChatMsg[] = [];
  if (sys) apiMsgs.unshift({ role: 'system', content: sys });
  // Only a message from the field touches the field's history walk: a follow-up
  // turn for the inbox leaves whatever is being typed, or recalled, as it is.
  if (!opts.fromInbox && !opts.hostAsk) pushHistory(c.prompts, q);
  // The images the text names, in the order it names them. A background result
  // is the model's writing and carries none.
  const images = opts.fromInbox || opts.hostAsk || !shape.images ? [] : imagesInText(q, c.images);
  const asked: ChatMessage = { role: 'user', content: q, ...(images.length ? { images } : {}) };
  apiMsgs.push(asked);
  // What goes to the provider: every image of the history as a part — read now,
  // not kept in the history, which holds its ref.
  const notes: string[] = [];
  const wire = wireMessages(apiMsgs, (ref) => c.resolveImage(ref, notes));
  const wireHasImages = wire.some((m) => Array.isArray(m.content));
  for (const note of notes) added.push({ role: 'note', content: note });
  // On screen the message is its text, with the numbers of the images sent, so
  // their tokens are drawn as attachments.
  added.push({ role: opts.fromInbox ? 'bg' : 'user', content: q, ...(images.length ? { images: images.map((r) => r.n) } : {}), ...(opts.hostAsk ? { hostAsk: true } : {}) });
  // The question joins the model's history now, so a failed or cancelled
  // turn still leaves it on record; the turn's transcript follows on success.
  c.api = [...c.api, opts.fromInbox ? { ...asked, role: 'bg' } : asked];
  // And the journal, before anything of the turn can happen: the notes, then the
  // question, which gives the session its id. The turn's own events go to that
  // session's journal even when a reset (/clear) lands while it runs — they
  // happened there.
  for (const m of added.slice(0, -1)) c.journal({ t: 'row', role: 'note', text: String(m.content ?? '') });
  const journalId = c.journal({
    t: 'row', role: opts.fromInbox ? 'bg' : 'user', text: q,
    ...(images.length ? { images: images.map((r) => ({ n: r.n, name: r.name, path: r.path })) } : {}),
    ...(opts.hostAsk ? { hostAsk: true } : {}),
  }, { person: true });
  // The round being written, for a turn cut off before the round ends: its text
  // and its reasoning so far.
  let roundText = '';
  let roundReasoning = '';
  // The output streams of this turn's run_command calls, by call.
  const callOutputs = new Map<string, ReturnType<typeof outputJournal>>();
  // Over the list as it is (`setRows`), never over `rows()` — the list as last
  // DRAWN. A message sent from a zero-delay timer (the queue after a turn, a
  // `!command` or a slash command; the ask after `!!`) can run before the render
  // carrying what just ended; a list built from what was drawn would throw that
  // away, and the finished block would come back live, ticking forever.
  c.setRows((cur) => [...(sys ? [{ role: 'system', content: sys } as ChatMsg] : []), ...cur.filter((m) => m.role !== 'system'), ...added]);
  c.turn += 1; // views this turn opens are its own, never the last turn's
  // Every one of this turn's async callbacks that could still fire after the chat left
  // this conversation (a tool's view, its changes, the turn's own final flush) checks
  // `c.closed`: a closed conversation draws nothing more.
  c.persist(); // the question survives a restart even if the answer does not
  c.setBusyDrawn(true);
  c.setPhase('thinking');
  c.nextVerb(); // the turn's first request gets a word of its own
  c.turnStartedAt = Date.now();
  c.content = '';
  c.setEmptyAnswer(false); c.setContinueOffer(false);
  c.setToolCount(0);
  c.setTurnTokens(0); // what the last turn cost is not what this one costs
  c.turnCached = 0;
  c.roundTools = false; // the turn starts with a round nobody knows anything about yet
  // The seconds on the status line are whatever is running now
  // (`segmentStartedAt`), not the whole turn's.
  c.beginSegment();
  // The chat: the history walk ends, the field empties (not for the host's own ask, nor
  // for a follow-up turn for the inbox), the error line goes, the ticker starts, the Esc
  // arm goes.
  c.emit({ type: 'turn-start', kind: 'turn', label: '', ...(opts.hostAsk ? { hostAsk: true } : {}), ...(opts.fromInbox ? { fromInbox: true } : {}) });
  const abort = new AbortController();
  c.abort = abort;
  c.stopKey = '';
  const ai = (cfg.ai ?? {}) as Record<string, any>;
  let failed = false, aborted = false;
  let failure = '';
  // The loop ran out of rounds with no answer. It is said where the answer
  // would be, in the warn colour, and it replaces the dim line under the
  // field that a wall of grey tool lines would otherwise hide.
  let roundLimit = 0;
  let lastStep = '';
  let limitTokens: number | undefined; // set when the token budget ended the turn
  c.inTurn = true; // a project note from here on waits for the turn's end (the `finally`)
  try {
    const chatResult = await c.deps.chatLLM(wire, {
      ...llmOpts(ai),
      signal: abort.signal,
      // Debug-log of tool calls (opt-in: config.debug.logTools).
      logTools: !!((c.deps.config() as Record<string, any>)?.debug?.logTools),
      // Plugin ai-tools (aiTools): agentChat runs their own run(args, toolCtx).
      extraTools: c.deps.pluginAiTools() as ToolDef[],
      // What the screens show, read again before every round of the turn and
      // sent at the END of its request, after the conversation — past what the
      // provider caches, and never into the history.
      requestTail: shape.screen ? () => screenBlock(c.deps.screen()) : undefined,
      // The system prompt with the project's instructions as they are before
      // each round — a `cd` in this turn is seen by its next round.
      // The summary is read fresh too: an automatic compaction between two
      // rounds replaces it.
      // So is the list of screens: a plugin that joins mid-turn is offered `ui_open` from
      // the next round, and its line comes with it. An unchanged list is the same bytes,
      // so a round without a change keeps the cached prefix.
      systemPrompt: sysParts ? () => chatSystem(sysParts, true) : workerSystem,
      ...(shape.maxRounds ? { maxRounds: shape.maxRounds } : {}),
      // A line about the turn itself (a tool call the model wrote as text), a
      // note in the conversation where it happened.
      onNote: (text: string, detail?: { markup?: string }) => {
        // The journal keeps the markup the note is about, as evidence.
        if (detail?.markup) c.journalTo(journalId, { t: 'markup', note: text, markup: detail.markup });
        if (c.closed) return;
        c.setRows((cur) => [...cur, { role: 'note', content: text }]);
        c.deps.notify();
      },
      // Before every request of the turn: past `ai.autoCompact.threshold` of the
      // window, the conversation is compacted first — at a request boundary, so
      // every call made so far has its result. The person's message stays, the
      // rest becomes the handoff; mid-turn the message says the work on it
      // goes on from the handoff, so it is not begun again. A compaction that
      // fails is logged and the request goes as it is; Esc stops it with the turn.
      beforeRequest: !shape.boundary ? undefined : async ({ round, transcript, measured }: { round: number; transcript: ChatMessage[]; measured?: number }) => {
        if (c.closed) return;
        // A settings file a command just changed is answered before the model
        // reads another word (the guard, above).
        await c.askConfigChanges();
        if (c.closed) return;
        // First what the person queued since the last request: it reaches the
        // model now, after the round's results, as their message — each one
        // whose wait is the next step (`queueWait`). On screen it stands where
        // it reached the model.
        const delivered: ChatMessage[] = [];
        if (round > 0) {
          // Every message whose wait is the next step (`queueWait`): not one
          // held with ⇥, nothing from a message naming an image on.
          const list = c.queue;
          const now = list.filter((_, i) => c.queueWait(list, i) === 'step');
          if (now.length) {
            c.queue = c.queue.filter((m) => !now.includes(m));
            c.syncQueue();
            for (const m of now) {
              pushHistory(c.prompts, m.text);
              // In the journal as the person's message, where it reached the model.
              c.journalTo(journalId, { t: 'row', role: 'user', text: m.text, midTurn: true });
            }
            delivered.push(...now.map((m): ChatMessage => ({ role: 'user', content: m.text })));
            c.setRows((cur) => [...cur, ...now.map((m): ChatMsg => ({ role: 'user', content: m.text }))]);
            c.deps.notify();
          }
        }
        const append = delivered.length ? { append: delivered } : undefined;
        // Then the size check, with those messages in.
        const limits = autoCompactLimits(c.deps.config().ai);
        if (!limits.enabled) return append;
        if (round === 0 && c.api.length < 2) return append; // nothing but the question to fold
        let next: number;
        if (typeof measured === 'number') next = measured + estimateTokens(JSON.stringify(delivered));
        else if (round === 0) { const r = c.contextReading(); next = r.measured ? r.used + estimateTokens(q) : r.used; }
        else next = c.contextReading(undefined, [...transcript, ...delivered], false).used;
        if (!overThreshold(next, c.contextWindow(), limits)) return append;
        c.setToolLabel('⚙ compact…');
        let result: Awaited<ReturnType<typeof foldIntoHandoff>>;
        try {
          result = await foldIntoHandoff(c, [...c.sentHistory(), ...transcript], abort.signal);
        } catch (e) {
          if (abort.signal.aborted || (e as Error)?.name === 'AbortError') throw e;
          c.deps.pushLog(`[compact] the automatic compaction failed, the request goes as it is: ${(e as Error)?.message}`);
          return append;
        } finally {
          c.setToolLabel('');
        }
        if (abort.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        if (c.closed) return append;
        // The person's message stays, the rest is the handoff; what they
        // queued since goes after it, as it would have without the compaction.
        const resumed: ChatMessage = round === 0 ? asked : { ...asked, content: `${q}\n\n${RESUMED_NOTE}` };
        c.summary = result.summary;
        c.usage = null; // the measured size was of the history just replaced
        c.api = [resumed];
        markCompacted(c, next, result.summary, result.incomplete, true);
        c.persist();
        const sysNow = sysParts ? chatSystem(sysParts, true) : shape.system === 'subagent' ? workerSystem() : '';
        return { messages: wireMessages([...(sysNow ? [{ role: 'system', content: sysNow } as ChatMessage] : []), resumed], (ref) => c.resolveImage(ref, [])), ...append };
      },
      // What this conversation has loaded; `tools_load` adds to it mid-turn.
      // The mode (`ai.toolLoading`) is applied by the `chatLLM` service.
      toolSet: c.toolSet,
      withholdTools: shape.withholdTools,
      toolCtx: {
        plan: c.plan,
        shell: c.shell,
        // The key that stopped this turn, which a stopped command names.
        stopKey: () => c.stopKey,
        // The model's history as the chat keeps it — whole, never stubbed —
        // where an earlier call's result is found by its id (run_command's
        // stdinFrom, src/assistant/tool-results.ts).
        toolResultHistory: () => c.api,
        // What `refreshProject` read when the directory was last set — `cd`
        // answers from it rather than reading the files a second time.
        projectInstructions: () => c.project,
        // What `recall` can bring back: the items of the turns before this one
        // (this turn's own are still in full), an image read again from its
        // path with the hash checked — a file gone is the tool's answer, not a
        // note — and the count the /context line shows.
        recall: shape.recall ? ({
          items: () => c.recallItems(),
          resolveImage: (ref: ImageRef) => c.resolveImage(ref, []),
          onRecalled: (id: string) => { c.recall.recalled.add(id); },
        } satisfies RecallSource) : undefined,
        // The conversation's project — the workspace its memory and its files
        // are in (src/assistant/workspace.ts), decided at its first message.
        workspaceProject: () => c.currentProject(),
        // The plugin's OWN host-issued token: a plugin can present itself but
        // not impersonate one.
        pluginToken: c.deps.pluginToken,
        // Nobody answers a question where nobody can answer a y/n (`deps.canAsk`).
        askUser: shape.askUser && c.deps.canAsk !== false ? (questions: AskQuestion[]) => c.askUser(questions) : undefined,
        // Every service a tool may call through ctx — flattened, not spread:
        // `host.services` is a per-plugin view whose HOST services sit on its
        // prototype, and `...obj` copies own properties only. A spread would hand
        // tools a ctx with no chatLLM, config, showMessage or pushLog, silently.
        ...allServices(c.deps.services()),
        // A run a tool starts through the host's LLM service — a plugin tool asking
        // the model — has its calls journaled by the host, in this turn's session
        // (following a fork). No tool is handed a way to write to the journal itself.
        chatLLM: c.journaledChatLLM(journalId),
        // A background task started from this turn: a child conversation whose calls are
        // journaled here, under this turn's journal id — and the host's slots it waits
        // for (src/assistant/registry.ts).
        startChild: (spec: ChildSpec) => c.startChild(spec, journalId),
        childSlots: c.deps.children,
      },
      confirmWrite: confirmFor(c.policy, { conv: c, journalId, ...(c.kind === 'task' ? { task: c.label } : c.kind === 'subagent' ? { subagent: c.label } : {}) }),
      // A view a tool opened, and every change to it. Its message is pushed on
      // the FIRST change, so it has its place — and its fold id — from the
      // start: a block opened while it ran is still open when it ends.
      onToolLive: (rec: ViewRecord) => c.offerLive(rec),
      // What a write changed goes on the answer being written the moment the
      // write lands — a block of its own that stays in the chat. Only on the
      // display message: `c.api` gets the transcript, which never holds it.
      // What the host's run_command prints, whole, as it arrives — a stream per
      // call, ended when the call ends.
      onToolOutput: (call: { id?: string; name: string }, chunk: string) => {
        const key = `${call.id ?? ''}\u0000${call.name}`;
        let o = callOutputs.get(key);
        if (!o) { o = outputJournal((ev) => c.journalTo(journalId, { ...ev, t: 'call-out', ...(call.id ? { id: call.id } : {}), name: call.name })); callOutputs.set(key, o); }
        o.push(chunk);
      },
      // A call that will run, or wait on a y/n: in the journal before it does.
      onToolStart: (call: { id?: string; name: string; args: Record<string, unknown>; confirm: boolean }) => c.journalTo(journalId, callStartEvent(call)),
      onToolRun: (run: ToolRun) => {
        const outKey = `${run.id ?? ''}\u0000${run.name}`;
        callOutputs.get(outKey)?.end();
        callOutputs.delete(outKey);
        // The call whole — its arguments as the model wrote them, its result as
        // the tool returned it, before the cap and before any stub.
        c.journalTo(journalId, callEndEvent(run, c.deps.viewRenderers()));
        // A call whose result arrives after the chat left this conversation
        // (/clear mid-turn, most often): it is gone from the screen, and every one
        // of this callback's effects — the status line, the flush, the ✎ diff
        // block — belongs to it, never to whatever is on screen now.
        if (c.closed) return;
        // The tool is done: until the model's next token it is thinking, and
        // the seconds on the line are the round's from here.
        c.endToolSegment();
        c.setPhase('thinking');
        // Any view this call opened has already been placed by `onToolLive`,
        // final phase included — flush now rather than waiting on the coalesce
        // timer, so it is on screen before the next round's tool label appears.
        c.flushLive();
        // The call and what it changed go into the turn in its own order: under
        // the step that led to it, above whatever the model writes next. A call
        // that left a view is shown by that view (a message of its own, placed
        // by `onToolLive`), so it is not drawn a second time as a trail line.
        const call = run.views?.length ? null : callRun(run);
        const calls: CallRun[] = call ? [call] : [];
        const changed: TurnPart[] = (run.changes ?? []).map((change) => ({ kind: 'change', change }));
        if (!calls.length && !changed.length) { c.deps.notify(); return; }
        c.setRows(cur => {
          const next = cur.slice();
          const last = next[next.length - 1];
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, parts: [...addCalls(last.parts ?? [], calls), ...changed] };
          else next.push({ role: 'assistant', content: '', parts: [...addCalls([], calls), ...changed] });
          return next;
        });
        c.deps.notify();
      },
      onTool: (name: string, args: unknown) => {
        c.setToolLabel(`⚙ ${name}(${String(args ?? '').slice(0, 40)})…`);
        c.setToolCount(c.toolCount + 1); // call counter for the turn — in the status line
        c.beginSegment(); // the seconds on the line are this tool's now
        c.deps.notify();
      },
      // Diagnostic trace of what EACH round emitted: finish_reason + how many
      // tool_calls streamed. Logged unconditionally so the `l` panel shows
      // whether the model actually attempted a tool call (`finish=tool_calls
      // toolCalls=1`) or just narrated a status change without calling
      // (`finish=stop toolCalls=0`). The missing "▸ tool calls" fold in the
      // chat was AMBIGUOUS — this disambiguates it.
      onRound: (info: { index: number; finishReason: string; toolCalls: number; contentLen: number; usage?: TokenUsage }) => {
        // This request is done: the next one — after its tools — says a new word.
        c.nextVerb();
        // What the turn costs: a round is billed for its prompt and its
        // answer, and a turn is several rounds. Only what the provider
        // actually reported is counted — one that reports nothing leaves the
        // figure off the screen rather than putting a guess there.
        if (info.usage) {
          // `ctx N%` (the context meter) is the size of the NEXT request,
          // from the last round alone — set here too, not only once the turn's
          // answer arrives, so a long turn shows it climbing round by round.
          c.usage = info.usage;
          c.setTurnTokens(c.turnTokens + info.usage.promptTokens + info.usage.completionTokens);
          // `setTurnTokens` above skips its re-render when the sum does not
          // change (a provider reporting usage with zero new tokens this
          // round) — notify explicitly so the reading still redraws.
          c.deps.notify();
        }
        if (typeof info.usage?.cachedTokens === 'number') c.turnCached += info.usage.cachedTokens;
        c.deps.pushLog(`[round ${info.index}] finish=${info.finishReason} toolCalls=${info.toolCalls} content=${info.contentLen}ch${info.usage ? ` tokens=${info.usage.promptTokens + info.usage.completionTokens}` : ''}`);
      },
      // Round content streams LIVE (the agent calls onLive per token) into `live`,
      // drawn in full and dim with a live mark until the round says what it is:
      // `onRoundKind` — it carries a tool call, so it is a step — or the round
      // ending without one (`onLiveCommit(…, true)`) — the answer.
      // This round carries tool calls — heard the moment the first fragment
      // of one arrives. Whatever of its text is on screen stays exactly where
      // it is: in `step` it joins its run's row, in `open` it keeps its rows.
      onRoundKind: () => {
        c.roundTools = true;
        c.setRows(cur => {
          const next = cur.slice();
          const last = next[next.length - 1];
          if (last?.role === 'assistant' && last.live) next[next.length - 1] = { ...last, liveQuiet: true };
          return next;
        });
        c.deps.notify();
      },
      onLive: (delta: string) => {
        if (!delta) return;
        roundText += delta;
        c.endToolSegment(); // the tool is done: the model is writing
        c.setPhase('writing');
        // Read now, not in the updater (see `c.roundTools`): a tool call that
        // came before the text makes the text a step from its first character.
        const quiet = c.roundTools;
        c.setRows(cur => {
          const next = cur.slice();
          const last = next[next.length - 1];
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, live: (last.live || '') + delta, liveQuiet: quiet || last.liveQuiet === true };
          else next.push({ role: 'assistant', content: '', live: delta, liveQuiet: quiet });
          return next;
        });
      },
      // reasoning and content arrive in one chunk as parallel streams: we
      // accumulate reasoning in a separate message field (not content!).
      onReasoning: (delta: string) => {
        roundReasoning += delta;
        c.endToolSegment(); // the tool is done: the model is thinking
        c.setPhase('thinking');
        c.setRows(cur => {
          const next = cur.slice();
          const last = next[next.length - 1];
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, reasoning: (last.reasoning || '') + delta };
          else next.push({ role: 'assistant', content: '', reasoning: delta });
          return next;
        });
      },
      // End of a round: where its text goes. isAnswer=true — the final answer
      // (`content`), false — a step, appended to the turn's parts in its place.
      // Either way the rows it was drawn with stay where they are.
      onLiveCommit: (text: string, isAnswer: boolean) => {
        // c.content is fixed here, where the callback fires, never inside the
        // `setRows` updater below: send() reads it in `finally` right after the
        // await to tell an answer from an empty turn, and every updater is a pure
        // function of the list.
        if (isAnswer) c.content = text;
        // A round's text once, when it is known what it is.
        if (isAnswer || text.trim() || roundReasoning) c.journalTo(journalId, { t: isAnswer ? 'answer' : 'step', text, ...(roundReasoning ? { reasoning: roundReasoning } : {}) });
        roundText = ''; roundReasoning = '';
        // The next round starts knowing nothing — reset here, where the
        // callback fires, never in the updater below.
        c.roundTools = false;
        const step: TurnPart[] = !isAnswer && text.trim() ? [{ kind: 'text', text }] : [];
        c.setRows(cur => {
          const next = cur.slice();
          const last = next[next.length - 1];
          if (last?.role !== 'assistant') {
            // A fresh message (a tool's view landed under the last one). It is
            // pushed even for a round that said nothing, as it always was: the
            // turn's trail and how it ended go on the message after the view.
            next.push({ role: 'assistant', content: isAnswer ? text : '', ...(step.length ? { parts: step } : {}) });
            return next;
          }
          // The answer is only added to, never replaced: the rows stay exactly
          // as they were drawn and simply stop being provisional.
          if (isAnswer) next[next.length - 1] = { ...last, content: text, live: '', liveQuiet: false };
          else next[next.length - 1] = { ...last, parts: endRound(last.parts ?? [], text), live: '', liveQuiet: false };
          return next;
        });
      },
    });
    c.deps.pushLog(`[chat] ${q.slice(0, 40)}… → ${q.length} chars${images.length ? ` + ${images.length} image${images.length === 1 ? '' : 's'}` : ''}`);
    roundLimit = Number((chatResult as { roundLimit?: number } | undefined)?.roundLimit ?? 0);
    lastStep = String((chatResult as { lastStep?: string } | undefined)?.lastStep ?? '');
    const limited = chatResult as { limitBy?: string; turnTokens?: number } | undefined;
    limitTokens = limited?.limitBy === 'tokens' ? Number(limited.turnTokens ?? 0) : undefined;
    const turn = (chatResult as { transcript?: ChatMessage[]; content?: string } | undefined);
    const reported = (chatResult as { usage?: TokenUsage } | undefined)?.usage;
    if (reported) c.usage = reported;
    c.api = [
      ...c.api,
      ...(turn?.transcript?.length ? turn.transcript : [{ role: 'assistant', content: turn?.content ?? '' }]),
      // Stopped at the cap: the turn is closed in the model's history by the
      // host's line saying where, and the person is offered ⏎ continue.
      ...(roundLimit ? [{ role: 'assistant', content: roundCapTurn(roundLimit, lastStep || undefined, limitTokens) } as ChatMessage] : []),
    ];
    if (roundLimit) c.setContinueOffer(true);
    // The calls are already in the turn, where they were made (`onToolRun`).
    const runs = (chatResult as { toolRuns?: unknown[] } | undefined)?.toolRuns ?? [];
    // After a real write the plugins reload what they show — otherwise an open
    // document keeps the text from before the write. It does not close the chat.
    if (runs.some(r => (r as { write?: boolean; outcome?: string }).write && (r as { outcome?: string }).outcome === 'applied')) {
      c.deps.afterWrite();
    }
  } catch (e) {
    // Esc during a stream is an expected cancel (AbortError) — not shown as an
    // error in the panel, but logged quietly.
    if ((e as Error)?.name === 'AbortError') {
      aborted = true;
      c.deps.pushLog('[chat] aborted by user');
    } else {
      failed = true;
      failure = String((e as Error)?.message ?? e);
      c.emit({ type: 'notice', text: (e as Error).message, level: 'error' });
      c.deps.pushLog(`[chat] error: ${(e as Error).message}`);
      // A model that cannot take images answers the first one with a 400. Said
      // once, in the provider's words, with the one switch that stops it — the
      // image stays in the history, so every later message would fail the same.
      const why = String((e as Error)?.message ?? '');
      if (wireHasImages && isImageRefusal(why) && !c.imageRefusalSaid) {
        c.imageRefusalSaid = true;
        c.pushNote(`The provider refused the image: ${why.slice(0, 300)}\nIf this model cannot take images: config set ai.images.enabled false — images already in the conversation then go as their names only.`);
      }
    }
    // The question is already in the model's history; left there alone it is a
    // question still waiting, and the next request shows the model two in a row —
    // it answers both, and goes back to the work the person stopped. So the
    // turn is closed in the model's own voice, after the tool calls that did
    // run (a write that landed before Esc happened; `apiHistory` drops a call
    // left without its result). Stopped: not to be picked up again unless
    // asked. Failed: said as a failure, so a retry the person asks for reads as
    // one. Model-side only — the screen says `stopped (Esc)` or the error.
    c.api = [
      ...c.api,
      ...transcriptSoFar(e),
      { role: 'assistant', content: aborted ? STOPPED_TURN : failedTurn((e as Error)?.message) },
    ];
  } finally {
    // The TURN's seconds — what the answer's quiet line keeps. The status
    // line's own number was the last running thing's and is gone with it.
    const finalMs = Date.now() - c.turnStartedAt;
    // Bind the TURN's duration and what it cost to this turn's answer (the
    // persistent «· 12.4 s · 3.1k tok» — read after the fact, where the
    // status line was about what was running), and mark an answer stopped
    // with Esc: cut short, «The» reads like a whole (and odd) answer unless
    // the line under it says it was stopped.
    const spent = c.turnTokens;
    const cachedSpent = c.turnCached;
    c.journalTo(journalId, {
      t: 'end', ms: finalMs, ...(spent ? { tokens: spent } : {}),
      ...(aborted ? { stopped: c.stopKey || keyGlyph('escape') } : {}), ...(failed ? { failed: failure } : {}),
      ...(roundLimit ? { roundLimit, ...(lastStep ? { lastStep } : {}), ...(limitTokens !== undefined ? { limitBy: 'tokens', turnTokens: limitTokens } : {}) } : {}),
      // A round cut off by Esc or an error never reached `onLiveCommit`.
      ...(roundText ? { cut: roundText } : {}), ...(roundReasoning ? { reasoning: roundReasoning } : {}),
    });
    // A command the turn ran may have changed a settings file (the guard).
    void c.askConfigChanges();
    c.setRows(cur => {
      // A round cut off by Esc or an error never said what it was. Its text
      // stays where it was drawn: a round known to carry a tool call — or
      // one that began with the `Next:` plan the prompt asks for before a
      // call — is a step (drawn exactly as it streamed, the token never);
      // any other is what the answer had come to (and the line under it
      // says it was stopped).
      const next = cur.map((m): ChatMsg => {
        if (m.role !== 'assistant' || !m.live) return m;
        const { live, liveQuiet, ...rest } = m;
        return liveQuiet || startsWithNext(live)
          ? { ...rest, parts: [...(rest.parts ?? []), { kind: 'text', text: live }] }
          : { ...rest, content: `${rest.content ?? ''}${live}` };
      });
      let at = answerAt(next);
      // How a turn that did not answer ended is its LAST row. One stopped,
      // failed or cut at a limit while a tool's block was its newest message (a
      // command's, a view's), or right after a queued message reached the
      // model, has no message of its own under that — the round that would have
      // made one never came — so its closing line gets one, rather than standing
      // above what the turn did after it. (An answer is always the turn's last
      // message: `onLiveCommit` puts it on a fresh one under a block.)
      if ((aborted || failed || roundLimit) && at >= 0 && at < next.length - 1) { next.push({ role: 'assistant', content: '' }); at = next.length - 1; }
      if (at >= 0) next[at] = { ...next[at]!, duration: finalMs, ...(spent ? { tokens: spent } : {}), ...(cachedSpent ? { cached: cachedSpent } : {}), ...(aborted ? { stopped: true, ...(c.stopKey ? { stoppedBy: c.stopKey } : {}) } : {}), ...(roundLimit ? { roundLimit, ...(lastStep ? { roundLimitAt: lastStep } : {}), ...(limitTokens !== undefined ? { roundLimitTokens: limitTokens } : {}) } : {}) };
      return next;
    });
    // Empty answer: the model gave only reasoning but no final text — say so
    // explicitly. Error and cancel (Esc) are not an empty answer — they
    // already have their own indication (⚠ error / quiet log); neither is a
    // turn that ran out of rounds, which now says so in the conversation
    // itself, where the answer would have been.
    // A turn that ended with an answer: when, and — the chat open — seen then.
    // A stopped or failed turn, or one with no final text, is not an answer
    // waiting to be read.
    if (c.content.trim() && !failed && !aborted && !roundLimit) {
      const at = new Date().toISOString();
      c.answeredAt = at;
      if (c.shows()) c.seenAt = at;
    }
    if (!c.content.trim() && !failed && !aborted && !roundLimit) c.setEmptyAnswer(true);
    // c.busy follows the stream lifecycle synchronously: true from `send`'s top
    // guard, false again HERE when the stream ends. Nothing a render does sets it, so a
    // render skipped (the chat closed mid-turn, an aborted turn that does not commit)
    // cannot leave it true — the inbox would hold every background result for good.
    c.busy = false;
    // The directory moved during the turn: its note goes under the answer.
    c.inTurn = false;
    if (c.projectNote) { const note = c.projectNote; c.projectNote = null; c.pushProjectNote(note); }
    // A plugin's news that came while the turn ran goes under its answer.
    if (c.laterNotes.length) { const notes = c.laterNotes; c.laterNotes = []; for (const n of notes) c.pushNote(n); }
    // A plan finished in this turn has nothing left to show: all it would say is
    // "N done", hanging over the next question. It goes when the answer ends (as
    // in Claude Code); a plan with anything still open stays.
    {
      const items = c.plan.snapshot();
      if (items.length && items.every((t) => t.status === 'done')) c.plan.reset();
    }
    // A conversation closed mid-turn already cleared c.liveBuf/c.liveSeen/c.liveTimer —
    // this is for the ordinary case.
    if (!c.closed) c.flushLive();
    // The turn is over, so everything in the history has had its turn in full:
    // a batch may now stub it (src/assistant/recall.ts, `decideBatch`) — past
    // the context threshold, or on the turn clock — every eligible item at
    // once, so the request's prefix moves once and not every turn. The
    // reading is the measured one where the provider reports usage.
    if (!c.closed && shape.recall) {
      const limits = recallLimits(ai);
      if (limits.enabled && decideBatch(c.recall, c.recallItems(), c.contextReading().ratio, limits)) {
        c.deps.pushLog(`[recall] ${c.recall.stubbed.size} bulky item${c.recall.stubbed.size === 1 ? '' : 's'} now go as stubs`);
      }
    }
    c.persist();
    c.lastEnd = {
      kind: 'turn',
      outcome: aborted ? 'stopped' : failed ? 'failed' : roundLimit ? 'limit' : c.content.trim() ? 'answer' : 'empty',
      ms: finalMs,
      ...(aborted ? { stoppedBy: c.stopKey || keyGlyph('escape') } : {}),
      ...(failed ? { error: failure } : {}),
      ...(roundLimit ? { limit: { rounds: roundLimit, lastStep, ...(limitTokens !== undefined ? { by: 'tokens' as const, turnTokens: limitTokens } : {}) } } : {}),
      ...(spent ? { tokens: spent } : {}),
      ...(cachedSpent ? { cached: cachedSpent } : {}),
    };
    c.setBusyDrawn(false);
    c.setToolLabel('');
    c.abort = null;
    // The chat: the ticker stops; a stopped or failed turn's queue comes back into the
    // field (`restoreQueue`) — before `afterTurn`, which sends it otherwise.
    c.emit({ type: 'turn-end', end: c.lastEnd });
    c.afterTurn(!aborted && !failed, !!roundLimit);
  }
  return true;
}

// ── Compaction ── /compact and the automatic one alike: the model's view becomes
// a handoff (`compactConversation`) that REPLACES the previous summary, which it
// was shown to carry forward. What the PERSON sees stays — the conversation above
// is theirs to scroll (wiping it down to the last message instead would read as
// /clear); a note marks where the model's view now begins, one row with how big
// that view was and is now (the reading `ctx N%` shows), `auto` when nobody
// asked, and the summary folded under it.
export async function foldIntoHandoff(c: Conversation, history: ChatMessage[], signal: AbortSignal): ReturnType<typeof compactConversation> {
  const ai = (c.deps.config().ai ?? {}) as Record<string, any>;
  const result = await c.deps.compact(history, { ...llmOpts(ai), signal, previous: c.summary });
  if (!signal.aborted && result.incomplete) c.deps.pushLog(`[compact] no usable handoff after a retry: ${result.incomplete}`);
  return result;
}
export function markCompacted(c: Conversation, before: number, summary: string, incomplete: string | undefined, auto: boolean): void {
  const after = c.contextReading().used;
  const sizes = before > 0 && after > 0 ? ` · ~${shortTokens(before)} → ~${shortTokens(after)} tokens` : '';
  const kept = incomplete ? ' · incomplete, previous kept' : '';
  const note = `── compacted${auto ? ' · auto' : ''}${sizes}${kept} ──`;
  c.journal({ t: 'compact', summary, note, ...(auto ? { auto: true } : {}) });
  c.setRows((cur) => [...cur, { role: 'note', content: note, summary }]);
}

// ── generic async slash command ──────────────────────────────────────────
// Runs a slash command asynchronously, NON-BLOCKING, using the SAME live
// spinner as an LLM round («⚙ <label>…» + the elapsed tick via t0/tick/
// elapsed): the chat stays interactive while the command works. A long-running
// plugin command runs through this helper. Guards
// on an active stream — one activity at a time.
// Esc and Ctrl+C stop it like a turn: it gets the turn's AbortController, and
// the wait is raced against the abort, so a request that ignores its signal
// still lets go of the chat at once. `fn` checks the signal before it applies
// anything, so a result arriving after the stop changes nothing.
export function runCommand(c: Conversation, label: string, fn: (signal: AbortSignal) => Promise<void>): void {
  if (c.busy) return;
  c.busy = true; // closed synchronously, as in a turn
  c.busyKind = 'command';
  const abort = new AbortController();
  c.abort = abort;
  c.stopKey = '';
  const stopped = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true }));
  let ok = false;
  let failure = '';
  c.setBusyDrawn(true);
  c.setToolLabel(`⚙ ${label}…`);
  c.turnStartedAt = Date.now();
  c.beginSegment(); // the command is the one thing running
  // The chat: the command leaves the field the moment it is submitted, as a sent message
  // does (it is in ↑ already); the error line goes; the ticker starts.
  c.emit({ type: 'turn-start', kind: 'command', label });
  Promise.race([fn(abort.signal), stopped])
    .then(() => { ok = !abort.signal.aborted; })
    .catch((e) => {
      failure = (e as Error)?.name === 'AbortError' ? `/${label} stopped (${c.stopKey || keyGlyph('escape')})` : (e as Error).message;
      c.emit({ type: 'notice', text: failure, level: 'error' });
    })
    .finally(() => {
      if (c.abort === abort) c.abort = null;
      c.busy = false;
      c.setBusyDrawn(false);
      c.setToolLabel('');
      c.lastEnd = { kind: 'command', outcome: ok ? 'done' : abort.signal.aborted ? 'stopped' : 'failed', ms: Date.now() - c.turnStartedAt, ...(failure ? { error: failure } : {}) };
      // The chat: the ticker stops, and a stopped or failed command's queue comes back.
      c.emit({ type: 'turn-end', end: c.lastEnd });
      // What was queued meanwhile goes out now, as after an answer — unless the
      // command was stopped or failed.
      c.afterTurn(ok);
      c.deps.notify();
    });
}

// `/compact`: the model's history becomes the handoff.
export function compact(c: Conversation): void {
  if (c.busy || c.api.length < 2) return;
  // The command body; the spinner, label and ticker live in runCommand.
  runCommand(c, 'compact', async (signal) => {
    // How big the model's view was — as `ctx N%` read it.
    const before = c.contextReading().used;
    // Compact what the MODEL saw (tool results included, a stubbed item as its
    // stub), not the display list.
    const { summary, incomplete } = await foldIntoHandoff(c, c.sentHistory(), signal);
    if (signal.aborted) return; // stopped: the history stays as it was
    c.summary = summary;
    c.usage = null; // the measured size was of the history just replaced
    c.api = [];
    // The loaded tools stay (`toolSet`): the work the summary describes goes on
    // with them, and loading them again would spend a round for nothing.
    markCompacted(c, before, summary, incomplete, false);
    c.persist();
    c.deps.showMessage('History compacted');
  });
}

// A settings file changed outside the host (src/config/load.ts, the guard) is
// put to the person as a y/n of its own, in the confirmation's place: yes lays
// it on the running config, no keeps it off until restart. Never answered by
// the auto mode — it does not go through `confirmWrite`. A stop or a reset that
// closes it answers nothing: the next check asks again. Asked between a round's
// results and the next request (`beforeRequest` waits for it), after a
// `!command` and after a turn — never over another pending y/n or question.
// The y/n sits in the conversation's one confirmation slot, so a write's y/n and this one
// never stand together; it closes no panel, and the auto mode never answers it.
export function askConfigChanges(c: Conversation): Promise<void> {
  // Nobody to ask (the one-shot prompt): never asked, never parked. The changed file stays
  // off, as the start left it, and the next start that can ask does (src/config/load.ts).
  if (c.deps.canAsk === false) return Promise.resolve();
  // Work that outlived the conversation it ran in (a command /clear stopped) asks in the
  // conversation the chat draws now, whose own y/n and question decide, as they do for
  // any check: the guard is the process's, and a closed conversation shows nothing.
  if (c.closed) {
    const cur = c.deps.current?.();
    return cur && cur !== c ? cur.askConfigChanges() : Promise.resolve();
  }
  if (c.configAsk) return c.configAsk;
  const svc = (c.deps.services() as { configChanges?: { check(): ConfigChange[]; apply(ch: ConfigChange): { applied: string[]; restart: string[] }; decline(ch: ConfigChange): string | null } }).configChanges;
  if (!svc || c.confirm || c.question) return Promise.resolve();
  // The guard is the process's, the y/n a conversation's: a change another open
  // conversation is asking about is left to it (AGENTS.md (Secrets)).
  const asking = c.configAskers;
  const changes = svc.check().filter((ch) => { const o = asking.get(ch.path); return !o || o === c || o.closed; });
  if (!changes.length) return Promise.resolve();
  const run = (async () => {
    for (const change of changes) {
      // The batch was read before the first y/n, which may wait for as long as the person
      // is away: by its turn a change may be another open conversation's to ask, or be
      // answered there already. Neither is asked here, and nothing is said of it.
      const asker = asking.get(change.path);
      if (asker && asker !== c && !asker.closed) continue;
      if (!svc.check().some((x) => x.path === change.path && x.hash === change.hash)) continue;
      asking.set(change.path, c);
      const answer = await new Promise<boolean | null>((resolve) => {
        c.confirm = { name: 'config', args: '', resolve: (ok, by = 'person') => resolve(by === 'person' ? ok : null) };
        const request = { name: 'config', args: '', title: `⚠ ${change.file} changed outside flow-assist — apply? (y/n)`, line: change.lines.join('\n'), whole: true, hint: `y applies it now · n puts the accepted settings back and keeps the change beside the file` };
        c.drawConfirm(request);
        // The settings guard's y/n, not a tool's: a view that closes its panels for a tool's y/n leaves them here.
        c.emit({ type: 'confirm', request, host: true });
        c.deps.notify();
      });
      // Its own entry only: a conversation closed while it asked may find the next asker's.
      if (asking.get(change.path) === c) asking.delete(change.path);
      if (answer === null) break;
      // A y/n answered late (a left conversation's waits for the person) may find the
      // change answered elsewhere, or the file changed again: only a change still pending
      // as it was asked is applied or declined.
      if (!svc.check().some((x) => x.path === change.path && x.hash === change.hash)) {
        c.pushNote(`${change.file} was already answered, or changed again since — nothing done here.`);
        continue;
      }
      if (answer) {
        const r = svc.apply(change);
        c.pushNote(`Applied ${change.file}: ${[...r.applied, ...r.restart.map((k) => `${k} (${RESTART_NOTE})`)].join(', ')}.`);
      } else {
        const kept = svc.decline(change);
        c.pushNote(`Put the accepted ${change.file} back${kept ? ` — the change is kept in ${path.basename(kept)}` : ''}.`);
      }
    }
  })().finally(() => { c.configAsk = null; for (const [p, o] of asking) if (o === c) asking.delete(p); });
  c.configAsk = run;
  return run;
}
