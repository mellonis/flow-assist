// How often a streamed answer draws. The chat draws its conversation's snapshot through
// `useSyncExternalStore`, whose changes React renders as urgent work before the stream
// reader's next await resumes; the conversation tells its subscribers once per
// macrotask while a turn runs (AGENTS.md, "The chat draws a `Conversation`'s
// snapshot"), so an answer draws once per network read, never once per delta. Counted
// in React commits, from the frame meter's every frame (its own window keeps only the
// last ones), never in wall time.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { createFrameMeter } from '../runtime/frame-stats.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Boots the chat with an answer of `n` deltas scripted, a counter of every commit, and —
// `chunked` — every network chunk (one delta each) handed to the reader in a macrotask of
// its own, as a provider's packets arrive.
async function streamed(n: number, chunked: boolean) {
  const model = new ScriptedModel();
  model.script(Array.from({ length: n }, (_, i) => ({ text: `w${i} ` })));
  const meter = createFrameMeter();
  let commits = 0;
  const frameOf = meter.frame;
  meter.frame = (st) => { commits += st.commits; frameOf(st); };
  const ui = await bootApp(model, 160, 50, undefined, undefined, { frameMeter: meter });
  let chunks = 0;
  if (chunked) {
    const scripted = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const res = await scripted(url, init);
      if (!res.body || !String(res.headers.get('content-type')).includes('event-stream')) return res;
      const reader = res.body.getReader();
      const body = new ReadableStream({
        async pull(c) {
          await new Promise((r) => setTimeout(r, 0));
          const { done, value } = await reader.read();
          if (done) { c.close(); return; }
          chunks++;
          c.enqueue(value);
        },
      }, { highWaterMark: 0 });
      return new Response(body, { headers: res.headers });
    }) as typeof fetch;
  }
  await ui.press('F');
  await ui.type('go');
  const before = commits;
  await ui.press('return');
  for (let i = 0; i < 500 && !ui.backend.lastFrame.includes(`w${n - 1}`); i++) await settle(2);
  await settle(10);
  expect(ui.backend.lastFrame).toContain(`w${n - 1}`);
  const drawn = commits - before;
  ui.app.unmount();
  return { commits: drawn, chunks };
}

test('an answer whose deltas arrive in one read draws a couple of times, not once per delta', async () => {
  const { commits } = await streamed(400, false);
  // The press that sends, and the answer: 2 at the time of writing.
  expect(commits).toBeLessThanOrEqual(4);
}, 60_000);

test('an answer whose deltas arrive in reads of their own draws once per read, not more', async () => {
  const n = 200;
  const { commits, chunks } = await streamed(n, true);
  expect(chunks).toBeGreaterThanOrEqual(n); // every delta came in a read of its own
  // Once per read comes to the reads ± 2 (the press that sends, the end, a read the
  // event loop merged); a telling that races React's scheduler — at once, or a single
  // `setImmediate` step — draws 6–9 % more. The line sits between the two.
  expect(commits).toBeLessThanOrEqual(chunks + Math.round(chunks * 0.035));
}, 60_000);
