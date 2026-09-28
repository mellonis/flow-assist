import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Conversation, LIVE_REDRAW_MS } from '../conversation.ts';
import { buildSecretSet, setActiveSecrets } from '../secrets.ts';
import { fakeDeps } from './conversation-deps.ts';

test('the queue: ⇥ holds one message, an image holds everything behind it, ↑ takes the last back', () => {
  const c = new Conversation(fakeDeps());
  c.images.set(1, { n: 1, path: '/x.png', name: 'x.png', mime: 'image/png', sha256: 'h', bytes: 1 });
  c.enqueue('a'); c.enqueue('b');
  expect([c.queueWait(c.queue, 0), c.queueWait(c.queue, 1)]).toEqual(['step', 'step']);
  expect(c.toggleHoldLast()).toBe(true);
  expect(c.queueWait(c.queue, 1)).toBe('end');
  c.enqueue('see [Image #1]'); c.enqueue('after');
  expect([c.queueWait(c.queue, 2), c.queueWait(c.queue, 3)]).toEqual(['image', 'behind']);
  expect(c.takeBackLast()).toBe('after');
  expect(c.restoreQueue()).toEqual(['a', 'b', 'see [Image #1]']);
  expect(c.restoreQueue()).toBeNull();
  expect(c.toggleHoldLast()).toBe(false);
});

test('a live view is placed at once, then coalesced, and its end is never held', async () => {
  const c = new Conversation(fakeDeps());
  const rec = (phase: 'live' | 'done', text: string) => ({ kind: 'console', data: { text }, phase, startedAt: 1, callId: 'k#1' }) as never;
  c.offerLive(rec('live', 'one'));
  expect(c.rows()).toHaveLength(1);
  c.offerLive(rec('live', 'two'));
  expect((c.rows()[0]!.views as { data: { text: string } }[])[0]!.data.text).toBe('one');
  await new Promise((r) => setTimeout(r, LIVE_REDRAW_MS + 50));
  expect((c.rows()[0]!.views as { data: { text: string } }[])[0]!.data.text).toBe('two');
  c.offerLive(rec('done', 'three'));
  expect((c.rows()[0]!.views as { phase: string }[])[0]!.phase).toBe('done');
  c.close('park');
  c.offerLive(rec('live', 'stale')); // the chat has left it since: dropped
  expect((c.rows()[0]!.views as { data: { text: string } }[])[0]!.data.text).toBe('three');
});

test('images are numbered on from the last one and restart after a reset', () => {
  const c = new Conversation(fakeDeps());
  const img = { ok: true as const, data: new Uint8Array([1]), ref: { path: '/a.png', name: 'a.png', mime: 'image/png', sha256: 'h1', bytes: 1 } };
  expect([c.attachImage(img), c.attachImage(img)]).toEqual([1, 2]);
  expect(c.imagesInText('[Image #2] and [Image #9]').map((r) => r.n)).toEqual([2]);
  c.resetImages();
  expect(c.attachImage(img)).toBe(1);
});

test('a plugin\'s note waits out a running turn, and a token in it is never shown', () => {
  const c = new Conversation(fakeDeps());
  c.inTurn = true;
  c.pluginNote('[mcp] server back');
  expect(c.laterNotes).toEqual(['[mcp] server back']);
  expect(c.rows()).toHaveLength(0);
  c.inTurn = false;
  c.pluginNote('[mcp] now');
  expect(c.rows().at(-1)).toMatchObject({ role: 'note', content: '[mcp] now' });
  c.pluginNote('');
  expect(c.rows()).toHaveLength(1);
  const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.payload-of-the-token.signature';
  setActiveSecrets(buildSecretSet({}, { WB_WIKI_TOKEN: TOKEN }));
  try {
    c.pluginNote(`[mcp] token=${TOKEN}`);
    expect(c.rows().at(-1)).toMatchObject({ role: 'note', content: '[mcp] token=‹secret WB_WIKI_TOKEN›' });
    c.inTurn = true;
    c.pluginNote(`[mcp] again ${TOKEN}`);
    expect(c.laterNotes.at(-1)).toBe('[mcp] again ‹secret WB_WIKI_TOKEN›');
  } finally {
    setActiveSecrets(null);
  }
});

test('the project\'s instructions are said once when the directory brings them', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-proj-')));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# rules\nbe brief\n');
  const deps = fakeDeps();
  (deps.config() as Record<string, unknown>).shell = { roots: [root] };
  const c = new Conversation(deps);
  c.shell.setCwd(root);
  c.shell.setCwd(root);
  const notes = c.rows().filter((m) => String(m.content ?? '').startsWith('Project instructions:'));
  expect(notes).toHaveLength(1);
  expect(c.contextReading([]).used).toBeGreaterThan(0);
});
