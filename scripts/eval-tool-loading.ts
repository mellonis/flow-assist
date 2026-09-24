// Behavioural eval: with tools on demand, does the model still find the tool a task
// needs — and in how many rounds, at what request size?
//
// A made-up plugin brings a dozen tools in three groups; each task can be done by
// exactly one of them. `--tools all` sends every definition; `--tools
// onDemand` sends the core tools and the index, and the model has to `tools_load`
// first. Same model, same tasks; only the tool list differs. Read the result as the
// other eval says (scripts/eval-tool-use.ts): a RATE over trials, compared between
// variants, never one run.
//
//   LLM_TOKEN=… bun scripts/eval-tool-loading.ts --base-url https://api.anthropic.com/v1 \
//       --model claude-haiku-4-5 --trials 3
//   bun scripts/eval-tool-loading.ts --fake     # no network: smoke-test the harness
//
// `--tools all|onDemand|both` (default both); `--token-env NAME`; `--show` prints the
// first trial's calls. Every run spends real money (tasks × trials × variants × rounds).

import { agentChat, requestTools, type ChatMessage, type ChatRoundResult } from '../src/assistant/agent.ts';
import { assembleToolRegistry, type ToolDef } from '../src/loader/tools.ts';
import { makeFactory } from '../src/loader/plugin.ts';
import type { ToolLoading } from '../src/assistant/tool-loading.ts';

const argv = process.argv.slice(2);
const many = (flag: string) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
const one = (flag: string, fallback: string) => many(flag).at(-1) ?? fallback;

const FAKE = argv.includes('--fake');
const models = many('--model').length ? many('--model') : [FAKE ? 'fake' : 'claude-haiku-4-5'];
const baseUrl = one('--base-url', 'https://api.anthropic.com/v1');
const token = process.env[one('--token-env', 'LLM_TOKEN')] ?? '';
const trials = Number(one('--trials', FAKE ? '1' : '3'));
const variants: ToolLoading[] = one('--tools', 'both') === 'both' ? ['all', 'onDemand'] : [one('--tools', 'both') as ToolLoading];
const SHOW = argv.includes('--show');

if (!FAKE && !token) {
  console.error(`No token: set ${one('--token-env', 'LLM_TOKEN')} (or pass --token-env NAME), or use --fake.`);
  process.exit(2);
}

// ─── the made-up plugin ───────────────────────────────────────────────────────
const tool = (name: string, description: string, props: Record<string, string> = {}): ToolDef => ({
  type: 'function',
  function: {
    name, description,
    parameters: { type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, d]) => [k, { type: 'string', description: d }])), required: Object.keys(props) },
  },
});
const GROUPS: Record<string, ToolDef[]> = {
  garden: [
    tool('garden_plants', 'List the plants in the garden. Each has a name and a bed.'),
    tool('garden_watered', 'When a plant was last watered. Returns a date.', { plant: 'The plant name' }),
    tool('garden_water', 'Record that a plant was watered now.', { plant: 'The plant name' }),
    tool('garden_frost', 'The frost forecast for the next three nights.'),
  ],
  pantry: [
    tool('pantry_list', 'List what is in the pantry, with amounts.'),
    tool('pantry_expiring', 'Items that expire within a week.'),
    tool('pantry_add', 'Add an item to the shopping list.', { item: 'What to buy' }),
    tool('pantry_recipes', 'Recipes that can be cooked from what is in the pantry.'),
  ],
  bike: [
    tool('bike_rides', 'The last ten rides, with distance and time.'),
    tool('bike_service', 'When the bike is next due for service.'),
    tool('bike_tyres', 'Tyre pressure recommendations for a rider weight.', { weight: 'Rider weight in kg' }),
    tool('bike_routes', 'Saved routes, with length and climb.'),
  ],
};
const ANSWERS: Record<string, string> = {
  garden_watered: '2026-09-18', garden_frost: 'no frost expected', pantry_expiring: 'yoghurt (2 days), spinach (4 days)',
  pantry_add: 'added', bike_service: 'in 340 km', bike_tyres: 'front 4.1 bar, rear 4.4 bar',
};
const TASKS: { ask: string; expect: string }[] = [
  { ask: 'When did I last water the basil?', expect: 'garden_watered' },
  { ask: 'Will there be frost in the next few nights?', expect: 'garden_frost' },
  { ask: 'What in my pantry is about to go off?', expect: 'pantry_expiring' },
  { ask: 'Put oat milk on my shopping list.', expect: 'pantry_add' },
  { ask: 'When is my bike due for a service?', expect: 'bike_service' },
  { ask: 'What tyre pressure should I use? I weigh 72 kg.', expect: 'bike_tyres' },
];

const make = makeFactory({});
const plugins = Object.entries(GROUPS).map(([id, tools]) => make(id, {
  tools: [{ id, tools, exec: async (name: string) => ANSWERS[name] ?? 'nothing recorded' }],
} as never));
assembleToolRegistry({ plugins, config: {}, repo: { list: async () => [] } as never });

// A stand-in that knows the answer: it loads when it must, then calls. It says
// nothing about any real model.
const fakeRound = (expect: string) => async (messages: ChatMessage[], opts: Record<string, unknown>): Promise<ChatRoundResult> => {
  const sent = ((opts.tools as ToolDef[]) ?? []).map((t) => t.function.name);
  const answered = messages.some((m) => m.role === 'tool' && String(m.content).startsWith('OK') && !String(m.content).startsWith('OK: Loaded'));
  if (answered) { (opts.onDelta as (d: string) => void)?.('Done.'); return { content: 'Done.', reasoning: '', finishReason: 'stop', toolCalls: [] }; }
  const call = (name: string, args: unknown) => ({ content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: `c${messages.length}`, name, arguments: JSON.stringify(args) }] });
  return sent.includes(expect) ? call(expect, {}) : call('tools_load', { names: [expect] });
};

type Row = { found: boolean; rounds: number; refused: number; loads: number };

async function run(model: string, mode: ToolLoading, task: { ask: string; expect: string }, show: boolean): Promise<Row> {
  let rounds = 0;
  const res = await agentChat(
    [{ role: 'system', content: 'You are an assistant in a terminal chat. Use the tools to answer; answer concisely.' }, { role: 'user', content: task.ask }],
    {
      baseUrl, model, token: token || 'fake', maxRounds: 8, toolLoading: mode, onLive: () => {}, onLiveCommit: () => {},
      onRound: () => { rounds++; },
      ...(FAKE ? { chatRound: fakeRound(task.expect) } : {}),
    },
  );
  const runs = res.toolRuns;
  const found = runs.some((r) => r.name === task.expect && r.outcome !== 'error');
  if (show) {
    console.log(`    you   › ${task.ask}`);
    for (const r of runs) console.log(`    tool  ⚙ ${r.name}(${JSON.stringify(r.args).slice(0, 80)}) → ${r.outcome}`);
    console.log(`    model ‹ ${res.content.replace(/\s+/g, ' ').slice(0, 120)}\n`);
  }
  return {
    found,
    rounds,
    refused: runs.filter((r) => r.outcome === 'error' && String(r.detail).includes('is not loaded')).length,
    loads: runs.filter((r) => r.name === 'tools_load').length,
  };
}

console.log(`models: ${models.join(', ')} · tools: ${variants.join(', ')} · ${TASKS.length} tasks × ${trials} trials${FAKE ? ' · FAKE (no network)' : ` · ${baseUrl}`}\n`);
for (const model of models) {
  for (const mode of variants) {
    const rows: Row[] = [];
    for (let t = 0; t < trials; t++) {
      for (const [i, task] of TASKS.entries()) {
        try { rows.push(await run(model, mode, task, SHOW && t === 0 && i < 3)); } catch (e) { console.error(`  ${task.expect}: ${(e as Error).message.slice(0, 160)}`); }
      }
    }
    const n = rows.length || 1;
    const avg = (f: (r: Row) => number) => (rows.reduce((s, r) => s + f(r), 0) / n).toFixed(1);
    console.log(`${model} · tools=${mode} · ${rows.length} runs`);
    console.log(`  found the tool     ${Math.round((100 * rows.filter((r) => r.found).length) / n)}%`);
    console.log(`  rounds per task    ${avg((r) => r.rounds)}`);
    console.log(`  tools_load calls   ${avg((r) => r.loads)}   refused (not loaded) ${avg((r) => r.refused)}`);
    // What the first request of a task carries, before anything is loaded.
    console.log(`  tool defs, 1st req ${JSON.stringify(requestTools([], mode)).length} chars\n`);
  }
}
