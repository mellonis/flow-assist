// A /command that runs for a while (/compact) leaves the field the moment it is
// submitted, as a sent message does, rather than sitting there until the command ends,
// and still goes into ↑. What was queued meanwhile goes out after it, or comes back
// into the field when it is stopped.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type UI = Awaited<ReturnType<typeof bootApp>>;
const fieldRow = (ui: UI) => ui.backend.lastFrame.split('\n').filter((r) => r.includes('› ')).at(-1) ?? '';
const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

// A conversation with one answer in it; the next request (/compact's) waits for `go()`.
async function talkedThenHeld(summary = 'SUMMARY: a greeting.') {
  const model = new ScriptedModel();
  model.script([{ text: 'Sure.' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('a question');
  await ui.press('return');
  await settle(14);
  const scripted = globalThis.fetch;
  let go: () => void = () => {};
  const gate = new Promise<void>((r) => { go = r; });
  let held = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    if (!JSON.parse(String(init.body)).stream && !held++) {
      await Promise.race([gate, new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))]);
      return new Response(JSON.stringify({ choices: [{ message: { content: summary } }] }), { headers: { 'content-type': 'application/json' } });
    }
    return scripted(url as string, init);
  }) as typeof fetch;
  return { ui, model, go: () => go() };
}

test('/compact leaves the field at once, the field stays empty after, and ↑ brings /compact back', async () => {
  const { ui, go } = await talkedThenHeld();
  await ui.type('/compact');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('compact…');
  expect(fieldRow(ui)).not.toContain('/compact');

  go();
  await settleUntil(() => ui.backend.lastFrame.includes('── compacted'));
  expect(ui.backend.lastFrame).not.toContain('compact…');
  expect(fieldRow(ui)).not.toContain('/compact');

  await ui.press('up');
  expect(fieldRow(ui)).toContain('› /compact');
  ui.app.unmount();
});

test('a draft typed while /compact runs is left alone when it ends', async () => {
  const { ui, go } = await talkedThenHeld();
  await ui.type('/compact');
  await ui.press('return');
  await ui.type('next thought');
  go();
  await settleUntil(() => ui.backend.lastFrame.includes('── compacted'));
  expect(fieldRow(ui)).toContain('› next thought');
  ui.app.unmount();
});

test('stopped with Esc, /compact puts nothing of its own back — a message queued meanwhile comes back', async () => {
  const { ui, model } = await talkedThenHeld();
  await ui.type('/compact');
  await ui.press('return');
  await ui.type('then this');
  await ui.press('return'); // queued behind the command
  expect(fieldRow(ui)).not.toContain('then this');
  await ui.press('escape');
  await settle(6);
  expect(ui.backend.lastFrame).toContain('/compact stopped (Esc)');
  expect(fieldRow(ui)).toContain('› then this');
  expect(fieldRow(ui)).not.toContain('/compact');
  expect(model.requests).toHaveLength(1); // the queued message was not sent
  ui.app.unmount();
});

test('a message queued behind /compact goes out once it is done', async () => {
  const { ui, model, go } = await talkedThenHeld();
  model.script([{ text: 'After the summary.' }]);
  await ui.type('/compact');
  await ui.press('return');
  await ui.type('then this');
  await ui.press('return');
  go();
  await settleUntil(() => ui.backend.lastFrame.includes('After the summary.'));
  expect(ui.backend.lastFrame).toContain('After the summary.');
  expect(JSON.stringify(model.requests.at(-1))).toContain('then this');
  expect(fieldRow(ui)).not.toContain('then this');
  ui.app.unmount();
});
