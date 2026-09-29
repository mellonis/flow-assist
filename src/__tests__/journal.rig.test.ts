// The session's journal (src/assistant/journal.ts), through the conversation: written as
// things happen — never at save — and never trimmed; a fork starts one of its own; the
// host writes every line from its own hooks, a background task's and a plugin's nested
// runs included. What `/export` renders of it is journal.e2e.test.ts.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { Make } from '../loader/plugin.ts';
import { bgActiveCount } from '../loader/tools-core.ts';
import { ScriptedModel, handoff } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';
import { sessionIdOf } from './helpers/session-files';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; closeRigs(); });

// A foreign write to a session's state file — a hand edit, an older host: the next save forks.
function foreignWrite(rig: Rig): string {
  const name = rig.stateFiles()[0]!;
  const file = path.join(rig.sessionsDir!, name);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, rev: Number(raw.rev) + 5 }));
  return sessionIdOf(name);
}
// The journal that is not the parent's.
const forkedOf = (rig: Rig, parent: string) => rig.journals().find((n) => !path.basename(n).startsWith(parent));

test('a crash before any save leaves every row and every call — whole, before the cap — in the journal', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ text: 'Next: посмотреть схему', tool: 'config_schema', args: {} }],
    [{ text: 'Схема на месте.' }],
  );
  const rig = conversationRig(model, { ai: { toolResultMaxChars: 200 } });
  await rig.conv.send('покажи схему');
  // The turn has ended; the save it scheduled is 250 ms away: this is what a crash would leave.
  expect(rig.stateFiles()).toHaveLength(0);
  const events = rig.journal();
  expect(events[0]).toMatchObject({ t: 'start' });
  expect(events.find((e) => e.t === 'row' && e.role === 'user')).toMatchObject({ text: 'покажи схему' });
  expect(events.find((e) => e.t === 'step')).toMatchObject({ text: 'Next: посмотреть схему' });
  const call = events.find((e) => e.t === 'call')!;
  expect(call).toMatchObject({ name: 'config_schema', args: {}, outcome: 'ok' });
  // The model got 200 characters and a cut note; the journal keeps what the tool returned.
  expect(String(call.result).length).toBeGreaterThan(1000);
  expect(String(call.result)).not.toContain('[cut:');
  expect(events.find((e) => e.t === 'answer')).toMatchObject({ text: 'Схема на месте.' });
  expect(events.at(-1)).toMatchObject({ t: 'end' });
  // The order is the order it happened in.
  expect(events.map((e) => e.t)).toEqual(['start', 'row', 'step', 'call-start', 'call', 'answer', 'end']);
  expect(rig.conv.lastAnswer()).toBe('Схема на месте.');
  rig.close();
});

test('a session longer than the cap: the state file lost its first question, the journal keeps it and every call', async () => {
  const many = (n: number) => Array.from({ length: n }, () => ({ tool: 'datetime', args: {} }));
  const model = new ScriptedModel();
  model.script(many(150), [{ text: 'первый готов' }], many(150), [{ text: 'второй готов' }], many(150), [{ text: 'третий готов' }]);
  const rig = conversationRig(model);
  for (const q of ['раз', 'два', 'три']) {
    await rig.conv.send(q);
    rig.conv.save(); // a save after every turn
  }
  const saved = rig.sessionFile()!;
  expect(saved.api.some((m) => (m as { content: unknown }).content === 'раз')).toBe(false);
  const events = rig.journal();
  expect(events.find((e) => e.t === 'row' && e.role === 'user')).toMatchObject({ text: 'раз' });
  expect(events.filter((e) => e.t === 'call')).toHaveLength(450);
}, 60_000);

test('a compact writes its summary to the journal, and the journal keeps what was compacted', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Тренд — вверх.' }], [{ text: handoff('Итог: тренд вверх.') }]);
  const rig = conversationRig(model);
  await rig.conv.send('как тренд?');
  rig.conv.compact();
  await rig.idle();
  expect(rig.conv.messages.some((m) => m.role === 'note' && String(m.content).includes('compacted'))).toBe(true);
  const events = rig.journal();
  const at = events.findIndex((e) => e.t === 'compact');
  expect(events[at]).toMatchObject({ summary: handoff('Итог: тренд вверх.') });
  expect(events.slice(0, at).some((e) => e.t === 'answer' && e.text === 'Тренд — вверх.')).toBe(true);
});

test('a note said before anything else waits for the session; /new starts a journal of its own', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'первый ответ' }], [{ text: 'второй ответ' }]);
  const rig = conversationRig(model);
  // What `/title` alone says, before anything was said.
  rig.conv.pushNote('This session has no title yet — /title <text> gives it one');
  expect(rig.journals()).toHaveLength(0); // nothing said yet: no session, no journal
  await rig.conv.send('первый вопрос');
  const first = rig.journal();
  expect(first.map((e) => e.t)).toEqual(['start', 'row', 'row', 'answer', 'end']);
  expect(first[1]).toMatchObject({ role: 'note' });
  expect(first[2]).toMatchObject({ role: 'user', text: 'первый вопрос' });
  rig.fresh(); // /new
  await rig.conv.send('второй вопрос');
  expect(rig.journals()).toHaveLength(2);
  const second = rig.journal();
  expect(second.some((e) => e.text === 'второй вопрос')).toBe(true);
  expect(second.some((e) => e.text === 'первый вопрос')).toBe(false);
});

test('a fork starts its own journal with a pointer to the session it came from', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'ответ' }], [{ text: 'ответ 2' }]);
  const rig = conversationRig(model);
  await rig.conv.send('первый вопрос');
  rig.conv.save(); // the first save
  const parent = foreignWrite(rig); // the next save forks
  await rig.conv.send('следующий вопрос');
  rig.conv.save();
  const forked = forkedOf(rig, parent)!;
  expect(forked).toBeDefined();
  expect(rig.journal(sessionIdOf(forked))[0]).toMatchObject({ t: 'start', parent });
});

test('a session saved before journals existed starts its journal with what its state file holds', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'ответ' }], [{ text: 'новый ответ' }]);
  const rig = conversationRig(model);
  await rig.conv.send('старый вопрос');
  rig.conv.save();
  const id = rig.conv.sessionId;
  rig.conv.releaseLock();
  rig.conv.close('park');
  for (const n of rig.journals()) fs.unlinkSync(path.join(rig.sessionsDir!, n)); // as an older host left it

  rig.open(id);
  await rig.conv.send('новый вопрос');
  const events = rig.journal(id);
  expect(events[0]).toMatchObject({ t: 'start', continued: true });
  expect(events[1]).toMatchObject({ t: 'row', role: 'user', text: 'старый вопрос', imported: true });
  expect(events.some((e) => e.t === 'row' && e.text === 'новый вопрос' && !e.imported)).toBe(true);
});

test('a !command is in the journal from the moment it starts; its output and its end — the exit and the time — follow', async () => {
  const rig = conversationRig(new ScriptedModel());
  const run = rig.conv.runShell('sleep 1; echo готово');
  await rig.until(() => rig.journals().length > 0);
  // Still running — what a crash now would leave: the command that ran.
  const started = rig.journal();
  expect(started.find((e) => e.t === 'shell')).toMatchObject({ command: 'sleep 1; echo готово' });
  expect(started.some((e) => e.t === 'shell-end')).toBe(false);
  await run;
  const end = rig.journal().find((e) => e.t === 'shell-end')!;
  expect(end).toMatchObject({ command: 'sleep 1; echo готово', status: expect.stringContaining('exit 0') });
  expect(rig.journal().filter((e) => e.t === 'shell-out').map((e) => e.text).join('')).toContain('готово');
  expect(typeof end.ms).toBe('number');
});

// A tool that frames its result for the model, as the mcp plugin does: the model reads
// the frame, cut; the data behind it is `raw`.
const BIG = Array.from({ length: 800 }, (_, i) => `row ${i}: ${'data '.repeat(9)}`).join('\n');
const framed = (make: Make) => make('framed', {
  tools: [{
    id: 'framed',
    tools: [
      { type: 'function', function: { name: 'get_big', description: 'Big data, framed.', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'get_none', description: 'A failure answered in words.', parameters: { type: 'object', properties: {} } } },
    ],
    exec: async (name: string) => {
      if (name === 'get_big') return { text: `Result of framed:get — data from a server.\n${BIG.slice(0, 2000)}\n… (clipped)`, raw: BIG };
      if (name === 'get_none') return { text: 'ERROR from framed:get — not found', raw: null };
      throw new Error(`Unknown tool: ${name}`);
    },
  }],
});

test('a framed result: the journal keeps the data behind the frame, whole', async () => {
  expect(BIG.length).toBeGreaterThan(40_000);
  const model = new ScriptedModel();
  model.script([{ tool: 'get_big', args: {} }, { tool: 'get_none', args: {} }], [{ text: 'ок' }]);
  const rig = conversationRig(model, { guests: (make) => [framed(make)] });
  await rig.conv.send('дай данные');
  const calls = rig.journal().filter((e) => e.t === 'call');
  expect(calls[0]).toMatchObject({ name: 'get_big', raw: BIG });
  expect(String(calls[0]!.result)).toContain('(clipped)');
  expect(calls[1]).toMatchObject({ name: 'get_none', raw: null });
});

test('a !command\'s whole output streams into the journal as it arrives — more than the host keeps', async () => {
  const rig = conversationRig(new ScriptedModel(), { shell: { maxChars: 100 } });
  await rig.conv.runShell('seq 1 3000');
  const events = rig.journal();
  const whole = Array.from({ length: 3000 }, (_, i) => `${i + 1}\n`).join('');
  const out = events.filter((e) => e.t === 'shell-out');
  expect(out.length).toBeGreaterThan(0);
  expect(out.map((e) => e.text).join('')).toBe(whole);
  const end = events.find((e) => e.t === 'shell-end')!;
  expect(end).toMatchObject({ command: 'seq 1 3000', status: expect.stringContaining('exit 0') });
  expect(end.output).toBeUndefined();
  expect(typeof end.ms).toBe('number');
});

test('no tool can write to the journal: a plugin tool\'s ctx has none', async () => {
  const seen: string[][] = [];
  const spy = (make: Make) => make('spy', {
    tools: [{
      id: 'spy',
      tools: [{ type: 'function', function: { name: 'look', description: 'Looks at its ctx.', parameters: { type: 'object', properties: {} } } }],
      exec: async (_name: string, _args: unknown, ctx: Record<string, unknown>) => { seen.push(Object.keys(ctx)); return 'ok'; },
    }],
  });
  const model = new ScriptedModel();
  model.script([{ tool: 'look', args: {} }], [{ text: 'ок' }]);
  const rig = conversationRig(model, { guests: (make) => [spy(make)] });
  await rig.conv.send('посмотри');
  expect(seen).toHaveLength(1);
  expect(seen[0]!.some((k) => /journal/i.test(k))).toBe(false);
});

test('a model tool call is journaled when it starts — waiting on a y/n — and the answer and its end follow', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'echo привет' } }], [{ text: 'Готово.' }]);
  const rig = conversationRig(model);
  const turn = rig.conv.send('скажи привет');
  await rig.until(() => rig.pending() !== null);
  // What a crash now would leave: the call that was about to run, and that it waited.
  const waiting = rig.journal();
  expect(waiting.find((e) => e.t === 'call-start')).toMatchObject({ name: 'run_command', args: { command: 'echo привет' }, confirm: true });
  expect(waiting.some((e) => e.t === 'call' || e.t === 'confirm')).toBe(false);
  rig.answerNext(true);
  await turn;
  const events = rig.journal();
  const start = events.find((e) => e.t === 'call-start')!;
  expect(events.find((e) => e.t === 'confirm')).toMatchObject({ id: start.id, name: 'run_command', answer: 'yes', by: 'person' });
  expect(events.find((e) => e.t === 'call')).toMatchObject({ id: start.id, outcome: 'applied' });
  expect(events.map((e) => e.t).filter((t) => (t.startsWith('call') && t !== 'call-out') || t === 'confirm')).toEqual(['call-start', 'confirm', 'call']);
});

test('a fork in the middle of a turn: the rest of the turn lands in the fork\'s journal, not the parent\'s', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'первый ответ' }], [{ hold: true }, { text: 'второй ответ' }]);
  const rig = conversationRig(model);
  await rig.conv.send('первый вопрос');
  rig.conv.save(); // the first save
  const parent = foreignWrite(rig);
  const turn = rig.conv.send('второй вопрос');
  await new Promise((r) => setTimeout(r, 400)); // the question's own save forks, mid-turn
  const forkedName = forkedOf(rig, parent)!;
  expect(forkedName).toBeDefined();
  model.release();
  await turn;
  expect(rig.journal(parent).some((e) => e.text === 'второй ответ')).toBe(false);
  const forked = rig.journal(sessionIdOf(forkedName));
  expect(forked[0]).toMatchObject({ t: 'start', parent });
  expect(forked.some((e) => e.t === 'answer' && e.text === 'второй ответ')).toBe(true);
});

test('a background task\'s own calls are journaled in the session that started it, under the task\'s label', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'background', args: { task: 'узнать время', label: 'часы' } }],
    [{ text: 'Запустил.' }],
    [{ tool: 'datetime', args: {} }],
    [{ text: 'Сейчас полдень.' }],
  );
  const rig = conversationRig(model);
  await rig.conv.send('узнай время в фоне');
  // The task runs detached: it is over only when nothing is in flight, and before this test
  // returns, or its next request would reach the real fetch.
  await rig.until(() => bgActiveCount() === 0 && rig.journal().some((e) => e.t === 'call' && e.task === 'часы'));
  const events = rig.journal();
  expect(events.find((e) => e.t === 'call-start' && e.task === 'часы')).toMatchObject({ name: 'datetime', args: {} });
  expect(events.find((e) => e.t === 'call' && e.task === 'часы')).toMatchObject({ name: 'datetime', outcome: 'ok' });
  expect(String(events.find((e) => e.t === 'call' && e.task === 'часы')!.result)).toContain('iso-utc');
});

// A plugin tool that asks the model through its own `ctx.chatLLM`: it is no background
// task, and the journal says so. With no confirmation of its own, a write the model
// calls there is declined by the host — no y/n, the "cannot ask" wording — and a
// confirmation it does pass is journaled as the plugin's answer.
async function pluginAsks(confirm: boolean) {
  const asker = (make: Make) => make('asker', {
    tools: [{
      id: 'asker',
      tools: [{ type: 'function', function: { name: 'ask_model', description: 'Asks the model.', parameters: { type: 'object', properties: {} } } }],
      exec: async (_name: string, _args: unknown, ctx: Record<string, any>) => {
        const res = await ctx.chatLLM([{ role: 'user', content: 'make the file' }], confirm ? { confirmWrite: () => true } : {});
        return String(res?.content ?? '');
      },
    }],
  });
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'ask_model', args: {} }],
    [{ tool: 'run_command', args: { command: 'echo made > made.txt' } }],
    [{ text: 'nested done' }],
    [{ text: 'ok' }],
  );
  const rig = conversationRig(model, { guests: (make) => [asker(make)] });
  await rig.conv.send('ask it');
  return { root: rig.root, events: rig.journal() };
}

test('a plugin tool\'s own chatLLM with no confirmation: the write is declined by the host, no y/n, no background task', async () => {
  const { root, events } = await pluginAsks(false);
  expect(fs.existsSync(path.join(root, 'made.txt'))).toBe(false);
  const call = events.find((e) => e.t === 'call' && e.name === 'run_command')!;
  expect(call).toMatchObject({ outcome: 'declined' });
  expect(String(call.result)).toContain('cannot ask the person');
  expect(call.task).toBeUndefined();
  expect(events.some((e) => e.t === 'confirm')).toBe(false);
  expect(events.some((e) => e.t === 'call-start' && e.name === 'run_command')).toBe(false);
});

test('a plugin tool\'s own confirmation is journaled as the plugin\'s answer, not a background task\'s', async () => {
  const { root, events } = await pluginAsks(true);
  expect(fs.readFileSync(path.join(root, 'made.txt'), 'utf8')).toBe('made\n');
  const confirm = events.find((e) => e.t === 'confirm')!;
  expect(confirm).toMatchObject({ name: 'run_command', answer: 'yes', by: 'plugin' });
  expect(confirm.task).toBeUndefined();
  expect(events.find((e) => e.t === 'call' && e.name === 'run_command')).toMatchObject({ outcome: 'applied' });
});

test('after a fork, reopening the session it came from writes to that session\'s own journal again', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'ответ' }], [{ text: 'ответ 2' }], [{ text: 'ответ в форке' }], [{ text: 'ответ в родителе' }]);
  const rig = conversationRig(model);
  await rig.conv.send('первый вопрос');
  rig.conv.save();
  const parent = foreignWrite(rig); // the next save forks
  await rig.conv.send('второй вопрос');
  rig.conv.save(); // the save that forks
  await rig.conv.send('вопрос в форке');
  const forkedName = forkedOf(rig, parent)!;
  expect(rig.journal(sessionIdOf(forkedName)).some((e) => e.text === 'ответ в форке')).toBe(true);
  // Back to the parent, as /resume opens it: the fork saved and left, the parent opened.
  rig.conv.save();
  rig.conv.releaseLock();
  rig.conv.close('park');
  rig.open(parent);
  await rig.conv.send('снова в родителе');
  expect(rig.journal(parent).some((e) => e.t === 'row' && e.text === 'снова в родителе')).toBe(true);
  expect(rig.journal(sessionIdOf(forkedName)).some((e) => e.text === 'снова в родителе')).toBe(false);
});

test('a model\'s run_command streams its whole output into the journal, beside the capped result the model got', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'seq 1 3000' } }], [{ text: 'Готово.' }]);
  const rig = conversationRig(model, { shell: { maxChars: 100 } });
  const turn = rig.conv.send('посчитай');
  await rig.until(() => rig.pending() !== null);
  rig.answerNext(true);
  await turn;
  const events = rig.journal();
  const whole = Array.from({ length: 3000 }, (_, i) => `${i + 1}\n`).join('');
  const call = events.find((e) => e.t === 'call')!;
  expect(events.filter((e) => e.t === 'call-out' && e.id === call.id).map((e) => e.text).join('')).toBe(whole);
  expect(String(call.result).length).toBeLessThan(1000); // what the model got stays capped
});

test('a y/n settled by a stop is recorded as the stop, not as the person\'s no', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'echo x' } }], [{ text: 'после' }]);
  const rig = conversationRig(model);
  const turn = rig.conv.send('сделай');
  await rig.until(() => rig.pending() !== null);
  rig.conv.stop('^c');
  await turn;
  expect(rig.journal().find((e) => e.t === 'confirm')).toMatchObject({ answer: 'no', by: 'stop' });
});

test('a run_command the auto mode lets run (shell.autoRun with /auto all) is journaled as answered by the auto mode', async () => {
  const model = new ScriptedModel();
  model.script([{ tool: 'run_command', args: { command: 'echo сам' } }], [{ text: 'Готово.' }]);
  const rig = conversationRig(model, { shell: { autoRun: true } });
  rig.conv.setAutoMode('all');
  await rig.conv.send('выполни сам');
  const events = rig.journal();
  expect(events.find((e) => e.t === 'call-start')).toMatchObject({ name: 'run_command', confirm: true });
  expect(events.find((e) => e.t === 'confirm')).toMatchObject({ name: 'run_command', answer: 'yes', by: 'auto' });
  expect(events.find((e) => e.t === 'call')).toMatchObject({ name: 'run_command', outcome: 'applied' });
});

test('the journal keeps a turn stopped at a limit, a corrective round with its markup, and a queued message delivered mid-turn', async () => {
  const model = new ScriptedModel();
  const markup = 'Checking.\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="clock">\n</｜DSML｜invoke>\n</｜DSML｜function_calls>';
  model.script([{ text: markup }], [{ tool: 'datetime', args: {} }, { hold: true }], [{ tool: 'datetime', args: {} }]);
  const rig = conversationRig(model, { ai: { maxRounds: 3 } });
  const turn = rig.conv.send('what time is it?');
  await rig.until(() => model.requests.length >= 2 && model.held);
  rig.conv.enqueue('in UTC');
  model.release();
  await turn;
  const events = rig.journal();
  // The corrective round, with the markup that caused it as evidence.
  expect(events.find((e) => e.t === 'markup')).toMatchObject({ note: 'tool call written as text — asked again', markup });
  // The queued message, as the person's, at the moment it reached the model: after the
  // second round's call, before the third round's.
  const at = events.findIndex((e) => e.t === 'row' && e.role === 'user' && e.text === 'in UTC');
  expect(events[at]).toMatchObject({ midTurn: true });
  const calls = events.map((e, i) => (e.t === 'call' ? i : -1)).filter((i) => i >= 0);
  expect(calls[0]!).toBeLessThan(at);
  expect(calls[1]!).toBeGreaterThan(at);
  // The turn stopped at the round cap, with where.
  expect(events.find((e) => e.t === 'end')).toMatchObject({ roundLimit: 3, lastStep: 'datetime {}' });
});

test('the journal keeps an automatic compaction with its summary, and a turn ended by the token budget', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'short' }]);
  const window = 20_000;
  const rig = conversationRig(model, { ai: { contextWindow: window, maxTurnTokens: 1 } });
  await rig.conv.send('first');
  const base = Math.ceil(JSON.stringify(model.requests[0]).length / 4);
  model.script([{ text: `BIG ${'b'.repeat(Math.ceil((window * 0.85 - base) * 4))}` }]);
  await rig.conv.send('tell me everything');
  const summary = `## Goal\nJOURNALED ${'f'.repeat(1500)}\n## Done\n-\n## In progress\n-\n## Open decisions\nnone\n## Facts learned\n-`;
  model.usage = { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } };
  model.script([{ text: summary }], [{ tool: 'datetime', args: {} }], [{ text: 'never' }]);
  await rig.conv.send('go on');
  const events = rig.journal();
  expect(events.filter((e) => e.t === 'end')).toHaveLength(3);
  expect(events.find((e) => e.t === 'compact')).toMatchObject({ auto: true });
  expect(String(events.find((e) => e.t === 'compact')!.summary)).toContain('JOURNALED');
  expect(events.filter((e) => e.t === 'end').at(-1)).toMatchObject({ roundLimit: 1, limitBy: 'tokens', lastStep: 'datetime {}' });
});
