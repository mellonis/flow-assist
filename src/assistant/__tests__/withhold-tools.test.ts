// `AgentOpts.withholdTools`: a withheld tool is not in any request or index, and a call
// the model makes to it answers as an unknown tool without running.
import { expect, test } from 'bun:test';
import { agentChat, type ChatRoundResult, type ToolRun } from '../agent.ts';
import { assembleToolRegistry, type ToolDef } from '../../loader/tools.ts';

const registry = () => assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as never });
const names = (o: Record<string, unknown>) => ((o.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
const done: ChatRoundResult = { content: 'done', reasoning: '', finishReason: 'stop', toolCalls: [] };

test('every tool in full: a withheld tool is never sent, and a call to it answers as unknown and never runs', async () => {
  registry();
  const offered: string[][] = [];
  let started = 0;
  let n = 0;
  const round = async (_m: unknown, o: Record<string, unknown>): Promise<ChatRoundResult> => {
    offered.push(names(o));
    if (n++ > 0) return done;
    return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [
      { id: 'c1', name: 'background', arguments: '{"task":"count the files"}' },
      { id: 'c2', name: 'datetime', arguments: '{}' },
    ] };
  };
  const runs: ToolRun[] = [];
  const res = await agentChat([{ role: 'user', content: 'go' }], {
    chatRound: round as never,
    withholdTools: ['background', 'subagent', 'remind'],
    onToolRun: (r) => runs.push(r),
    // Were `background` to run, it would start a task through this hook.
    toolCtx: { startChild: () => { started++; throw new Error('a withheld tool ran'); }, childSlots: {} } as never,
  });
  expect(offered).toHaveLength(2);
  for (const sent of offered) {
    expect(sent).not.toContain('background');
    expect(sent).not.toContain('remind');
    expect(sent).toContain('datetime');
  }
  expect(runs.map((r) => [r.name, r.outcome])).toEqual([['background', 'error'], ['datetime', 'ok']]);
  expect(runs[0]!.detail).toBe('Error: Unknown tool: background');
  expect(res.transcript.filter((m) => m.role === 'tool').map((m) => String(m.content))[0]).toBe('ERROR: Unknown tool: background');
  // No task was started: the hook a task starts through was never called.
  expect(started).toBe(0);
});

test('tools on demand: a withheld tool is in neither the request nor the index, and tools_load cannot load it', async () => {
  registry();
  const extra = (name: string): ToolDef => ({ type: 'function', function: { name, description: `The ${name} tool.`, parameters: { type: 'object', properties: {} } }, run: async () => `${name} ran` } as ToolDef);
  const offered: Record<string, unknown>[] = [];
  let n = 0;
  const round = async (_m: unknown, o: Record<string, unknown>): Promise<ChatRoundResult> => {
    offered.push(o);
    if (n++ > 0) return done;
    return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'tools_load', arguments: '{"names":["ext_hidden","ext_open"]}' }] };
  };
  const runs: ToolRun[] = [];
  await agentChat([{ role: 'user', content: 'go' }], {
    chatRound: round as never,
    toolLoading: 'onDemand',
    extraTools: [extra('ext_open'), extra('ext_hidden')],
    withholdTools: ['background', 'ext_hidden'],
    onToolRun: (r) => runs.push(r),
  });
  expect(offered).toHaveLength(2);
  for (const o of offered) {
    expect(names(o)).not.toContain('background');
    expect(names(o)).not.toContain('ext_hidden');
    // The index is the tools_load tool's description: the withheld name is not in it.
    expect(JSON.stringify(o.tools)).not.toContain('ext_hidden');
  }
  expect(names(offered[0]!)).not.toContain('ext_open'); // on demand: indexed, not loaded
  expect(names(offered[1]!)).toContain('ext_open');     // loaded by the call
  // tools_load says it knows no such tool, in its own exact wording (`notInList`).
  expect(runs[0]!.detail).toBe('Loaded: ext_open — call them now. Not in the list: ext_hidden.');
});
