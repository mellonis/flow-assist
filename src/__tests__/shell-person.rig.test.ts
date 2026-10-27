// The background shells as the person sees and starts them: the tree rows, the toasts for
// every end, `!cmd &`, the footer's count and the export. Real processes, a scripted model.
import { afterEach, expect, test } from 'bun:test';
import type { Conversation } from '../assistant/conversation.ts';
import { exportMarkdown } from '../assistant/journal.ts';
import type { ShellJob } from '../assistant/shell-job.ts';
import { ScriptedModel } from './helpers/scripted';
import { closeRigs, conversationRig, type Rig } from './helpers/conversation';

const strays: ShellJob[] = [];
afterEach(() => {
  for (const j of strays.splice(0)) { try { j.killNow('exit'); } catch { /* ended */ } }
  closeRigs();
});

const START = [{ text: 'Hello.' }];
const anchor = async (rig: Rig) => { await rig.conv.send('hi'); await rig.idle(); };
function job(c: Conversation, command: string, by: 'model' | 'person' = 'model'): ShellJob {
  const r = c.startJob({ command, cwd: c.shell.cwd(), by });
  if (!('job' in r)) throw new Error(r.refused);
  strays.push(r.job);
  return r.job;
}
const settleTick = () => new Promise((r) => setTimeout(r, 60));
const shells = (c: Conversation) => c.tree().filter((n) => n.kind === 'shell');
function subagentOf(rig: Rig, by: 'model' | 'person'): Conversation {
  const started = rig.conv.startChild({ kind: 'subagent', label: 'sub', prompt: 'p', by }, rig.conv.ensureSessionId());
  if (!('child' in started)) throw new Error(started.refused);
  return started.child;
}

test('a kept job is a row of the tree, working, with its command, state and line count; a probe is not', async () => {
  const model = new ScriptedModel();
  model.script(START);
  const rig = conversationRig(model);
  await anchor(rig);
  const probe = rig.conv.jobPort().start({ command: 'sleep 30', cwd: rig.conv.shell.cwd(), by: 'model' });
  if (!('job' in probe)) throw new Error('refused');
  strays.push(probe.job);
  expect(shells(rig.conv)).toEqual([]);
  expect(rig.conv.shownJobs()).toEqual([]);
  expect(rig.registry.shellCount()).toBe(0);
  rig.conv.jobPort().keep(probe.job);
  expect(shells(rig.conv)).toMatchObject([{ key: 'job:sh-1', label: 'sh-1', kind: 'shell', depth: 1, status: 'working', shell: { id: 'sh-1', command: 'sleep 30', state: 'running', running: true, lines: 0 } }]);
  expect(rig.conv.jobByKey('job:sh-1')).toMatchObject({ owner: rig.conv });
  expect(rig.registry.shellCount()).toBe(1);
});

test('the row updates in place: output tells the tree (held to its window) and the line count follows', async () => {
  const model = new ScriptedModel();
  model.script(START);
  const rig = conversationRig(model);
  await anchor(rig);
  const heard: number[] = [];
  rig.conv.on('tree', () => heard.push(shells(rig.conv)[0]?.shell?.lines ?? -1));
  job(rig.conv, 'echo one; sleep 0.1; echo two; echo three; sleep 30');
  await rig.until(() => shells(rig.conv)[0]?.shell?.lines === 3);
  await rig.until(() => heard.at(-1) === 3);
  expect(heard.length).toBeGreaterThan(1);
});

test('a job that ends unread keeps its row, answered, until the person opens it; one the person killed leaves at once', async () => {
  const model = new ScriptedModel();
  model.script(START);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  await anchor(rig);
  const a = job(rig.conv, 'echo done; exit 3');
  await a.wait(3000);
  await rig.until(() => shells(rig.conv).length === 1 && shells(rig.conv)[0]!.status === 'idle');
  expect(shells(rig.conv)[0]).toMatchObject({ key: 'job:sh-1', status: 'idle', answered: true, shell: { state: 'exited 3', running: false, lines: 1 } });
  expect(rig.registry.shellCount()).toBe(0);
  const b = job(rig.conv, 'sleep 30');
  expect(shells(rig.conv)).toHaveLength(2);
  rig.conv.killJob(b, 'person');
  await b.wait(5000);
  await rig.until(() => shells(rig.conv).length === 1);
  rig.conv.readJob(a);
  expect(shells(rig.conv)).toEqual([]);
  // What a job's end is still lives among the ended ones.
  expect(rig.conv.jobById('sh-1')).toBe(a);
});

test('a job killed by the model or by a signal keeps its unread row; /clear takes the rows with the record', async () => {
  const model = new ScriptedModel();
  model.script(START);
  const rig = conversationRig(model);
  await anchor(rig);
  const a = job(rig.conv, 'sleep 30');
  rig.conv.jobPort().kill(a, 'model');
  await a.wait(5000);
  await rig.until(() => shells(rig.conv).length === 1 && !shells(rig.conv)[0]!.shell!.running);
  expect(shells(rig.conv)[0]!.shell!.state).toBe('killed (model)');
  rig.conv.close('clear');
  expect(shells(rig.conv)).toEqual([]);
});

test('a subagent\'s job is a row under the subagent\'s depth, and its running jobs are counted', async () => {
  const model = new ScriptedModel();
  model.script(START);
  const rig = conversationRig(model);
  await anchor(rig);
  const sub = subagentOf(rig, 'person');
  job(sub, 'sleep 30');
  job(rig.conv, 'sleep 31');
  const nodes = rig.conv.tree();
  expect(nodes.map((n) => [n.key, n.depth, n.kind])).toEqual([[sub.key, 1, 'subagent'], ['job:sh-1', 2, 'shell'], ['job:sh-2', 1, 'shell']]);
  expect(nodes[0]!.below).toBe(1);
  expect(rig.conv.jobByKey('job:sh-1')!.owner).toBe(sub);
  expect(rig.registry.shellCount()).toBe(2);
});

test('every kept job end is a toast: the code or the kill and how long, wherever the job lives and whoever started it', async () => {
  const model = new ScriptedModel();
  model.script(START, [{ text: 'woke' }]);
  const rig = conversationRig(model, { ai: { backgroundFollowUp: false } });
  await anchor(rig);
  const mine = job(rig.conv, 'exit 4', 'person');
  await mine.wait(3000);
  await rig.until(() => rig.toasts.some((t) => t.startsWith('sh-1 ')));
  expect(rig.toasts.find((t) => t.startsWith('sh-1 '))).toMatch(/^sh-1 exited 4 after (<1s|\d+s)$/);
  const killed = job(rig.conv, 'sleep 30');
  rig.conv.killJob(killed, 'person');
  await killed.wait(5000);
  await rig.until(() => rig.toasts.some((t) => t.startsWith('sh-2 ')));
  expect(rig.toasts.find((t) => t.startsWith('sh-2 '))).toMatch(/^sh-2 killed \(person\) after /);
  // A staying subagent's job: nobody is woken, the person is told.
  const sub = subagentOf(rig, 'person');
  const s = job(sub, 'echo hi');
  await s.wait(3000);
  await rig.until(() => rig.toasts.some((t) => t.startsWith('sh-3 ')));
  expect(rig.toasts.find((t) => t.startsWith('sh-3 '))).toMatch(/^sh-3 exited 0 after /);
  // A session the chat has left toasts too.
  const left = rig.conv;
  const l = job(left, 'sleep 0.2');
  rig.switchTo();
  await l.wait(3000);
  await rig.until(() => rig.toasts.some((t) => t.startsWith('sh-4 ')));
  // The ones a closing conversation causes say nothing.
  const quiet = job(rig.conv, 'sleep 30');
  rig.conv.close('clear');
  await quiet.wait(5000);
  await settleTick();
  expect(rig.toasts.some((t) => t.startsWith('sh-5 '))).toBe(false);
});

test('a job that woke the model says so in its toast, with the end and the job named; at the cap it says the model was not woken', async () => {
  const model = new ScriptedModel();
  model.script(START, [{ text: 'w1' }], [{ text: 'w2' }], [{ text: 'w3' }]);
  const rig = conversationRig(model);
  await anchor(rig);
  job(rig.conv, 'echo built');
  await rig.until(() => model.requests.length === 2);
  await rig.idle();
  expect(rig.toasts.filter((t) => t.startsWith('sh-1 '))).toEqual([expect.stringMatching(/^sh-1 exited 0 after \S+ — waking the model$/)]);
  for (let n = 2; n <= 3; n++) {
    job(rig.conv, `echo run${n}`);
    await rig.until(() => model.requests.length === 1 + n);
    await rig.idle();
  }
  const a = job(rig.conv, 'echo run4');
  await a.wait(3000);
  await rig.until(() => rig.toasts.some((t) => t.startsWith('sh-4 ')));
  const t4 = rig.toasts.filter((t) => t.startsWith('sh-4 '));
  expect(t4).toHaveLength(1);
  expect(t4[0]).toMatch(/^sh-4 exited 0 after \S+ — the model was not woken \(woken 3 times in a row without a message from you\)$/);
});

test('a model job whose wake is held (a turn runs) toasts its end at once and the wake when it comes', async () => {
  const model = new ScriptedModel();
  model.script(START, [{ text: 'working' }, { hold: true }], [{ text: 'Seen.' }]);
  const rig = conversationRig(model);
  await anchor(rig);
  const turn = rig.conv.send('go on');
  await rig.until(() => model.held);
  const j = job(rig.conv, 'echo early');
  await j.wait(3000);
  await rig.until(() => rig.toasts.some((t) => t.startsWith('sh-1 ')));
  expect(rig.toasts.filter((t) => t.startsWith('sh-1 '))).toEqual([expect.stringMatching(/^sh-1 exited 0 after \S+$/)]);
  model.release();
  await turn;
  await rig.until(() => rig.toasts.some((t) => t.endsWith('— waking the model')));
  // The wake does not say the end a second time.
  expect(rig.toasts.filter((t) => t.startsWith('sh-1 '))).toHaveLength(2);
  expect(rig.toasts.at(-1)).toBe('sh-1 — waking the model');
  expect((rig.conv as unknown as { toldWake: Set<string>; toastedEnd: Set<string> }).toldWake.size).toBe(0);
  expect((rig.conv as unknown as { toldWake: Set<string>; toastedEnd: Set<string> }).toastedEnd.size).toBe(0);
});

test('`!cmd &` starts a job of the person\'s: whole environment, the conversation\'s directory, the field free, ↑ keeps the line', async () => {
  const model = new ScriptedModel();
  model.script(START);
  process.env.FA_PERSON_ENV = 'kept-whole';
  try {
    const rig = conversationRig(model);
    await anchor(rig);
    expect(rig.conv.runBackground('echo $FA_PERSON_ENV; pwd; sleep 30', 'echo $FA_PERSON_ENV; pwd; sleep 30 &')).toBe(true);
    const j = rig.conv.jobById('sh-1')!;
    strays.push(j);
    expect(j.by).toBe('person');
    expect(rig.conv.busy).toBe(false);
    await rig.until(() => j.lines === 2);
    expect(j.read(0).text).toBe(`kept-whole\n${rig.root}\n`);
    expect(rig.conv.prompts.at(-1)).toBe('!echo $FA_PERSON_ENV; pwd; sleep 30 &');
    expect(rig.toasts.at(-1)).toBe('sh-1 started in the background · echo $FA_PERSON_ENV; pwd; sleep 30');
    expect(shells(rig.conv)).toHaveLength(1);
    // The journal knows who started it.
    expect(rig.journal().find((e) => e.t === 'job-start')).toMatchObject({ id: 'sh-1', command: 'echo $FA_PERSON_ENV; pwd; sleep 30', by: 'person' });
  } finally { delete process.env.FA_PERSON_ENV; }
});

test('`!cmd &` at the limit is refused with the running jobs listed, and starts nothing', async () => {
  const model = new ScriptedModel();
  model.script(START);
  const rig = conversationRig(model, { shell: { maxBackground: 1 } });
  await anchor(rig);
  job(rig.conv, 'sleep 30');
  const errors: string[] = [];
  rig.conv.on('notice', (e) => errors.push(e.text));
  expect(rig.conv.runBackground('sleep 31', 'sleep 31 &')).toBe(false);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/^!: [\s\S]*- sh-1 · sleep 30/);
  expect(rig.conv.prompts.at(-1)).not.toBe('!sleep 31 &');
  expect(rig.registry.jobs.list()).toHaveLength(1);
});

test('/export shows the person\'s `!cmd &` and its output stitched under the job', async () => {
  const model = new ScriptedModel();
  model.script(START);
  const rig = conversationRig(model);
  await anchor(rig);
  rig.conv.runBackground('echo first; sleep 0.1; echo second', 'echo first; sleep 0.1; echo second &');
  const j = rig.conv.jobById('sh-1')!;
  await j.wait(3000);
  await rig.until(() => rig.journal().some((e) => e.t === 'job-end'));
  const md = exportMarkdown(rig.journal(), { title: '', id: rig.conv.sessionId });
  expect(md).toContain('echo first; sleep 0.1; echo second');
  expect(md).toContain('background sh-1, started by you');
  expect(md).toContain('```console\nfirst\nsecond\n```');
  expect(md).toContain('*exit 0 ·');
});
