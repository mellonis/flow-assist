// A turn whose answer fell into a loop: the chat keeps the text before the repeat, says
// in the warn colour what it dropped, and offers the existing ⏎ continue. The model's
// history gets the trimmed answer closed by ONE line of the host's — the dropped text is
// never sent back to it — and the journal keeps the count and the head of what went.
// The detector and where the trim lands are agent.test.ts's; this is the caller's half.
import { afterEach, expect, test } from 'bun:test';
import { loopTurn } from '../assistant/system-prompt.ts';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { closeRigs, conversationRig, type Sent } from './helpers/conversation';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; closeRigs(); });
const settleUntil = async (ok: () => boolean, n = 300) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };
type Msg = { role: string; content: unknown };

// 1 000 code units of exact repeats after `ok `, ending on a unit boundary: the kept head
// is byte-exact (`loop-guard.ts`; a run cut mid-unit keeps part of its unit — ≤ 31 code
// units — so nothing here may depend on a mid-unit ending). The stream is cut the moment
// the guard fires, at whatever chunk boundary that is, so the count is read back from the
// record rather than assumed.
const LOOP = 'loop '.repeat(200);

const endOf = (events: { t: string; [k: string]: unknown }[]) => events.find((e) => e.t === 'end')!;

test('the next request sends the trimmed answer and one closing message', async () => {
  const model = new ScriptedModel();
  model.script([{ text: `ok ${LOOP}` }], [{ text: 'Picking up.' }]);
  const rig = conversationRig(model);
  await rig.conv.send('go on');
  expect(model.requests).toHaveLength(1); // the looped round is the answer: nothing asks again
  expect(rig.conv.continueOffer).toBe(true);
  // What the model's history holds now: the trimmed answer, then the host's one line.
  const end = endOf(rig.journal());
  const dropped = Number(end.looped);
  expect(dropped).toBeGreaterThanOrEqual(400);
  expect(rig.conv.api.at(-1)).toEqual({ role: 'assistant', content: loopTurn(dropped) });
  expect(rig.conv.api.at(-2)).toMatchObject({ role: 'assistant', content: 'ok ' });
  // The next request carries it — and no part of the repeat.
  await rig.conv.send('and now');
  const sent = rig.sent(1) as Sent[];
  expect(sent.at(-1)).toEqual({ role: 'user', content: 'and now' });
  expect(sent.at(-2)).toMatchObject({ role: 'assistant', content: loopTurn(dropped) });
  expect(sent.at(-3)).toMatchObject({ role: 'assistant', content: 'ok ' });
  expect(JSON.stringify(sent)).not.toContain('loop loop');
});

test('the journal records the loop', async () => {
  const model = new ScriptedModel();
  model.script([{ text: `ok ${LOOP}` }]);
  const rig = conversationRig(model);
  await rig.conv.send('go on');
  const events = rig.journal();
  const end = endOf(events);
  // The count of code units dropped, and the head of them — bounded evidence, not a pile
  // of repetitions nobody would read (src/assistant/loop-guard.ts).
  expect(Number.isInteger(Number(end.looped))).toBe(true);
  expect(Number(end.looped)).toBeGreaterThanOrEqual(400);
  const tail = String(end.loopTail);
  expect(tail.startsWith('loop ')).toBe(true);
  expect(tail.length).toBeLessThanOrEqual(2000);
  // What the journal keeps as the answer is the head the person reads, never the repeat.
  expect(events.find((e) => e.t === 'answer')).toMatchObject({ text: 'ok ' });
});

test('the panel says so and offers continue', async () => {
  const model = new ScriptedModel();
  model.script([{ text: `ok ${LOOP}` }], [{ text: 'Picking up.' }]);
  const ui = await bootApp(model, 140, 30, undefined, { ai: { baseUrl: 'http://scripted.model', model: 'scripted', toolLoading: 'all' } });
  await ui.press('F');
  await ui.type('go on');
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('the answer was looping'));
  await settle(8);
  const frame = ui.backend.lastFrame;
  // The exact line, in the warn colour, right under the trimmed answer — drawn where
  // `stopped after N rounds` is (`src/views/modals.ts`, the limit row).
  const lines = frame.split('\n');
  const line = lines.findIndex((r) => r.includes('⚠ stopped — the answer was looping'));
  expect(line).toBeGreaterThan(-1);
  expect(lines[line]).toMatch(/⚠ stopped — the answer was looping \(\d+ chars dropped\); it is not kept in the model's history/);
  // The head the person read is above it, the model's `ƒ` mark beside both.
  expect(lines.slice(0, line).some((r) => r.includes('ok'))).toBe(true);
  // The offer is the existing one: the hint row says ⏎ continue, and Enter sends it.
  expect(frame).toMatch(/⏎ continue · \S+ new line/);
  await ui.press('return');
  await settleUntil(() => ui.backend.lastFrame.includes('Picking up.'));
  const sent = (model.requests[1] as { messages: Msg[] }).messages;
  expect(sent.at(-1)).toEqual({ role: 'user', content: 'continue' });
  // The closing line is in what `continue` carried with it.
  expect(String(sent.at(-2)!.content)).toContain('fell into a loop');
  ui.app.unmount();
});
