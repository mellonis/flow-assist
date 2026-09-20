// Behavioural eval: does the model keep CALLING the plan tool turn after turn?
//
// The scenario is the one that exposed the bug: ask for seven random numbers in
// the plan, then name a number twice — first mention starts it, second completes
// it — for several numbers in a row. The failure was never the first turns; it
// was turn three onwards, when the model began narrating the change instead of
// calling `todo`.
//
// How to read an LLM eval (there is never one exact answer, so don't look for one):
//   1. Assert on BEHAVIOUR and STATE, never on wording — "was `todo` called this
//      turn" and "is the item really in_progress/done", read from the tool's own
//      state, not from what the model says about it.
//   2. Run N trials and report a RATE. One run proves nothing either way.
//   3. Compare variants that differ in exactly one thing. `--history display`
//      replays only each turn's final text (the old chat behaviour); `--history
//      api` replays tool calls and results (the fix). Same model, same prompts.
//   4. Break the rate down BY TURN — a flat average hides a failure that only
//      starts on turn three.
//   5. Run the same eval across models: a gap between variants that holds across
//      models is the harness; a gap between models under one variant is the model.
//
// Every run spends real money (trials × ~11 turns × rounds per model/variant).
//
//   LLM_TOKEN=… bun scripts/eval-tool-use.ts --base-url https://api.anthropic.com/v1 \
//       --model claude-opus-5 --model claude-haiku-4-5 --trials 5 --numbers 4
//   bun scripts/eval-tool-use.ts --fake            # no network: smoke-test the harness
//
// `--token-env NAME` reads the key from another variable; `--history api|display|both`
// (default both); `--out file.jsonl` keeps every turn for later inspection;
// `--show` prints the first trial's whole dialogue — what you said, every tool
// call with its arguments and outcome, and what the model answered.

import { appendFileSync } from 'node:fs';
import { agentChat, apiHistory, type ChatMessage, type ChatRoundResult } from '../src/assistant/agent.ts';
import { assembleToolRegistry, execChatTool } from '../src/loader/tools.ts';
import { todoSnapshot } from '../src/loader/tools-core.ts';

type Variant = 'api' | 'display';
const argv = process.argv.slice(2);
const many = (flag: string) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
const one = (flag: string, fallback: string) => many(flag).at(-1) ?? fallback;

const FAKE = argv.includes('--fake');
const models = many('--model').length ? many('--model') : [FAKE ? 'fake' : 'claude-opus-5'];
const baseUrl = one('--base-url', 'https://api.anthropic.com/v1');
const token = process.env[one('--token-env', 'LLM_TOKEN')] ?? '';
const trials = Number(one('--trials', FAKE ? '1' : '5'));
const numbers = Number(one('--numbers', '4'));
const variants: Variant[] = one('--history', 'both') === 'both' ? ['display', 'api'] : [one('--history', 'both') as Variant];
const out = one('--out', '');
const SHOW = argv.includes('--show'); // print the first trial's whole dialogue

if (!FAKE && !token) {
  console.error(`No token: set ${one('--token-env', 'LLM_TOKEN')} (or pass --token-env NAME), or use --fake.`);
  process.exit(2);
}

const SYSTEM = 'You are an assistant in a terminal chat. Answer concisely.';
const planBlock = () => {
  const plan = todoSnapshot();
  return plan.length ? `\n\n## Current task plan\n${plan.map((t) => `${t.id} · ${t.text} (${t.status})`).join('\n')}` : '';
};

// A deterministic stand-in so the harness itself can be checked without a key: it
// always calls the tool. It says nothing about any real model.
const fakeRound = async (messages: ChatMessage[]): Promise<ChatRoundResult> => {
  const last = messages.at(-1)!;
  if (last.role === 'tool') return { content: 'ok', reasoning: '', finishReason: 'stop', toolCalls: [] };
  const text = String(last.content);
  const call = (args: unknown) => ({ content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: `c${messages.length}`, name: 'todo', arguments: JSON.stringify(args) }] });
  if (text.startsWith('Think of')) return call({ action: 'add', items: ['11', '22', '33', '44', '55', '66', '77'] });
  const item = todoSnapshot().find((t) => t.text === text.trim());
  return call({ action: item?.status === 'in_progress' ? 'complete' : 'start', text: text.trim() });
};

// `claimed`: the reply asserts the change. A claim with no tool call is the failure
// this eval exists to catch — the model saying it did what it did not do.
type TurnResult = { turn: number; expected: string; called: boolean; stateOk: boolean; claimed: boolean; reply: string };

async function trial(model: string, variant: Variant, show = false): Promise<TurnResult[]> {
  await execChatTool('todo', { action: 'clear' }, {});
  // `api` keeps what was really exchanged; `display` keeps what the old chat kept.
  let history: ChatMessage[] = [];
  const results: TurnResult[] = [];

  const say = async (text: string) => {
    const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM + planBlock() }, ...apiHistory(history), { role: 'user', content: text }];
    const res = await agentChat(messages, { baseUrl, model, token: token || 'fake', maxRounds: 8, onLive: () => {}, onLiveCommit: () => {}, ...(FAKE ? { chatRound: fakeRound } : {}) });
    history = [...history, { role: 'user', content: text }, ...(variant === 'api' ? res.transcript : [{ role: 'assistant', content: res.content }])];
    if (show) {
      console.log(`    you   › ${text.length > 90 ? `${text.slice(0, 90)}…` : text}`);
      for (const r of res.toolRuns) console.log(`    tool  ⚙ ${r.name}(${JSON.stringify(r.args).slice(0, 110)}) → ${r.outcome}`);
      if (!res.toolRuns.length) console.log('    tool  · (none called)');
      console.log(`    model ‹ ${res.content.replace(/\s+/g, ' ').slice(0, 160)}`);
      console.log(`    plan    ${todoSnapshot().map((t) => `${t.text}${t.status === 'done' ? '✓' : t.status === 'in_progress' ? '◐' : ''}`).join(' ')}\n`);
    }
    return res;
  };

  // The rule is stated once, up front. Without it a bare number is ambiguous and
  // the right answer is "what do you want me to do with it?" — which a first
  // version of this eval scored as a failure.
  await say('Think of 7 random two-digit numbers and put them into the plan as 7 separate items, one number per item. Then list them. From now on I will only send numbers: the first time I send a number, mark that item as in progress; the second time I send the same number, mark it as done.');
  const plan = todoSnapshot();
  if (plan.length !== 7) return [{ turn: 0, expected: '7 items', called: plan.length > 0, stateOk: false, claimed: false, reply: `plan has ${plan.length} items` }];

  let turn = 0;
  for (const item of plan.slice(0, numbers)) {
    for (const expected of ['in_progress', 'done'] as const) {
      turn++;
      const res = await say(item.text);
      const now = todoSnapshot().find((t) => t.id === item.id);
      results.push({ turn, expected, called: res.toolRuns.some((r) => r.name === 'todo'), stateOk: now?.status === expected, claimed: /\b(in progress|marked|done|complete|started|finished)\b/i.test(res.content) && !/\?\s*$/.test(res.content.trim()), reply: res.content.slice(0, 80) });
    }
  }
  return results;
}

assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as never });
const turns = numbers * 2;
console.log(`models: ${models.join(', ')} · variants: ${variants.join(', ')} · trials: ${trials} · ${turns} turns each${FAKE ? ' · FAKE (no network)' : ` · ${baseUrl}`}\n`);

for (const model of models) {
  for (const variant of variants) {
    const called = Array<number>(turns).fill(0);
    const stateOk = Array<number>(turns).fill(0);
    const lied = Array<number>(turns).fill(0);
    let completed = 0;
    for (let t = 0; t < trials; t++) {
      let rows: TurnResult[] = [];
      if (SHOW && t === 0) console.log(`  ── ${model} · history=${variant} · trial 1 dialogue ──`);
      try { rows = await trial(model, variant, SHOW && t === 0); } catch (e) { console.error(`  trial ${t + 1} failed: ${(e as Error).message.slice(0, 160)}`); continue; }
      if (out) appendFileSync(out, `${JSON.stringify({ model, variant, trial: t, rows })}\n`);
      if (rows[0]?.turn === 0) { console.error(`  trial ${t + 1}: setup failed — ${rows[0].reply}`); continue; }
      completed++;
      rows.forEach((r) => { if (r.called) called[r.turn - 1]!++; if (r.stateOk) stateOk[r.turn - 1]!++; if (r.claimed && !r.called) lied[r.turn - 1]!++; });
    }
    const pct = (n: number) => (completed ? `${Math.round((100 * n) / completed)}%`.padStart(4) : '   –');
    console.log(`${model} · history=${variant} · ${completed}/${trials} trials`);
    console.log(`  turn        ${Array.from({ length: turns }, (_, i) => String(i + 1).padStart(4)).join(' ')}`);
    console.log(`  tool called ${called.map(pct).join(' ')}`);
    console.log(`  state right ${stateOk.map(pct).join(' ')}`);
    console.log(`  false claim ${lied.map(pct).join(' ')}   ← said it changed the plan, called nothing\n`);
  }
}
