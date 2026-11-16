// A turn whose answer fell into a loop: the chat keeps the text before the repeat, says
// in the warn colour what it dropped, and offers the existing ⏎ continue. The model's
// history gets the trimmed answer closed by ONE line of the host's — the dropped text is
// never sent back to it — and the journal keeps the count and the head of what went.
// The detector and where the trim lands are agent.test.ts's; this is the caller's half.
import { afterEach, expect, test } from 'bun:test';
import { loopTurn } from '../assistant/system-prompt.ts';
import { chatRows, type RowOpts } from '../views/modals';
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
  expect(rig.conv.api.at(-1)).toEqual({ role: 'assistant', content: loopTurn(dropped, true) });
  // A head was kept, and the closing line says the text above it is where it stopped.
  expect(String((rig.conv.api.at(-1) as { content?: unknown }).content ?? '')).toContain('the text above is where it stopped');
  expect(rig.conv.api.at(-2)).toMatchObject({ role: 'assistant', content: 'ok ' });
  // The next request carries it — and no part of the repeat.
  await rig.conv.send('and now');
  const sent = rig.sent(1) as Sent[];
  expect(sent.at(-1)).toEqual({ role: 'user', content: 'and now' });
  expect(sent.at(-2)).toMatchObject({ role: 'assistant', content: loopTurn(dropped, true) });
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

// The guard can fire on the answer's first characters: nothing of it survives the cut
// (`loop-guard.ts`'s `at === 0`), and then the closing line must say that, never point at
// a head that is not there. The turn stays a turn with no final text — `runTurn`
// classifies by what was kept, as it does for any turn that ends with nothing (`empty`) —
// so nothing reads as an answer waiting to be read. The run is one character repeated, so
// it starts at 0 whatever chunk boundary the guard fires on (a unit of several code units
// could begin mid-unit and keep a few characters).
const WHOLE_LOOP = 'z'.repeat(1200);

test('a loop the guard caught before any text says nothing was kept', async () => {
  const model = new ScriptedModel();
  model.script([{ text: WHOLE_LOOP }], [{ text: 'Picking up.' }]);
  const rig = conversationRig(model);
  await rig.conv.send('go on');
  expect(model.requests).toHaveLength(1);
  const dropped = Number(endOf(rig.journal()).looped);
  expect(dropped).toBeGreaterThanOrEqual(400);
  // Nothing was kept: the empty answer round, then the host's line saying so — the head
  // it would otherwise point at is not in the history.
  expect(rig.conv.api.at(-2)).toMatchObject({ role: 'assistant', content: '' });
  const closing = String((rig.conv.api.at(-1) as { content?: unknown }).content ?? '');
  expect(closing).toBe(loopTurn(dropped, false));
  expect(closing).not.toContain('text above');
  expect(closing).toContain('nothing of it was kept');
  // The turn's outcome is `empty`, as for any turn that ends with no final text: there is
  // nothing for the person to read, so it is not an answer (`answeredAt`, the picker's
  // `done`). It is not the "reasoning only" note either — the warn line says why.
  expect(rig.conv.lastEnd?.outcome).toBe('empty');
  expect(rig.conv.emptyAnswer).toBe(false);
  expect(rig.conv.continueOffer).toBe(true);
  // On screen the same: the warn line, and nothing drawn as an answer above it — the run
  // the person watched stream is never kept as text.
  const opts: RowOpts = { wrap: 100, folds: { open: false, except: new Set() }, viewLines: 20, notes: 'step', detailsKey: '^o', renderers: {}, now: Date.now(), palette: {} };
  const laid = chatRows(rig.conv.messages as Parameters<typeof chatRows>[0], opts);
  const text = (r: (typeof laid)[number]) => (r.spans ?? []).map((s) => String(s.text ?? '')).join('');
  const warn = laid.findIndex((r) => text(r).includes('the answer was looping'));
  expect(warn).toBeGreaterThan(-1);
  expect(laid.slice(0, warn).some((r) => r.role === 'assistant')).toBe(false);
  expect(laid.some((r) => text(r).includes('zzzzzz'))).toBe(false);
  // The next request carries the same honest line and no part of the run.
  await rig.conv.send('and now');
  const sent = rig.sent(1) as Sent[];
  expect(String(sent.at(-2)!.content)).toBe(loopTurn(dropped, false));
  expect(JSON.stringify(sent)).not.toContain('text above');
  expect(JSON.stringify(sent)).not.toContain('zzzzzz');
  // The journal's end says a loop stopped the turn and keeps the evidence — it claims no
  // answer, no stop by the person and no failure.
  const end = endOf(rig.journal());
  expect(String(end.loopTail).startsWith('z')).toBe(true);
  expect(end).not.toHaveProperty('failed');
  expect(end).not.toHaveProperty('stopped');
  expect(end).not.toHaveProperty('roundLimit');
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
