// Bulky content — an attached image, a `!command`'s output, a large tool result — is
// sent in full in the turn it arrives in and, once a batch has decided so, as a stub the
// model recalls by id. The arithmetic: which items exist, their ids (content hashes),
// their stubs, when a batch fires, what a stub replaces, and how an id is looked up.
import { expect, test } from 'bun:test';
import crypto from 'node:crypto';
import type { ChatMessage } from '../agent';
import { apiHistory } from '../agent';
import type { ImageRef } from '../images';
import {
  RECALL_DEFAULTS, applyRecall, bulkyItems, createRecallState, decideBatch, findItem, hashOf, itemId,
  recallLimits, recallLine, recallResult, saveRecallState,
} from '../recall';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const image = (over: Partial<ImageRef> = {}): ImageRef => ({ n: 1, name: 'shot.png', path: '/tmp/shot.png', sha256: 'a'.repeat(64), mime: 'image/png', bytes: 100, width: 3384, height: 2078, ...over });
const big = (n = 5000) => Array.from({ length: n / 10 }, (_, i) => `line ${i}`.padEnd(9)).join('\n');

test('the config: on by default, every number defaulted or checked', () => {
  expect(recallLimits(undefined)).toEqual(RECALL_DEFAULTS);
  expect(recallLimits({ recall: { enabled: false } }).enabled).toBe(false);
  expect(recallLimits({ recall: { threshold: 0.3, minChars: 100, everyTurns: 0 } })).toEqual({ enabled: true, threshold: 0.3, minChars: 100, everyTurns: 0 });
  // Out of range or the wrong type — the default, never a silent zero.
  expect(recallLimits({ recall: { threshold: 7, minChars: -1, everyTurns: 'x' } })).toEqual(RECALL_DEFAULTS);
});

test('an id is the kind and the first 8 hex of the content\'s sha256', () => {
  expect(hashOf('brew update')).toBe(sha('brew update'));
  expect(itemId('out', hashOf('x'))).toBe(`out:${sha('x').slice(0, 8)}`);
});

test('bulky items: each image, each !command output, each tool result over the size — identical content once', () => {
  const ref = image();
  const out = 'The person ran a shell command in /w:\n$ brew update\n(exit 0 · 24.7 s)\n```\n' + big(1200) + '\n```';
  const res = `OK: ${big(5000)}`;
  const api: ChatMessage[] = [
    { role: 'user', content: 'look [Image #1]', images: [ref] },
    { role: 'assistant', content: 'A screenshot.' },
    { role: 'shell', content: out, shell: { command: 'brew update', outcome: 'exit 0', ms: 24_700, lines: 120 } },
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: res },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'datetime', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'OK: noon' }, // small — never bulky
    { role: 'assistant', content: 'Done.' },
    // The same image and the same output again: the same ids, listed once.
    { role: 'user', content: 'again [Image #1]', images: [ref] },
    { role: 'shell', content: out, shell: { command: 'brew update', outcome: 'exit 0', ms: 24_700, lines: 120 } },
  ];
  const items = bulkyItems(api, 4096);
  expect(items.map((i) => i.kind)).toEqual(['img', 'out', 'res']);
  const [img, sh, tool] = items;
  expect(img!.id).toBe(`img:${'a'.repeat(8)}`);
  expect(img!.stub).toBe(`[image shot.png · 3384×2078 — recall("img:aaaaaaaa")]`);
  expect(img!.ref).toBe(ref);
  expect(sh!.id).toBe(itemId('out', hashOf(out)));
  expect(sh!.stub).toBe(`[$ brew update — exit 0 · 24.7 s · 120 lines — recall("${sh!.id}")]`);
  expect(sh!.content).toBe(out);
  expect(tool!.id).toBe(itemId('res', hashOf(res)));
  expect(tool!.stub).toBe(`[read_file src/app.ts — 500 lines — recall("${tool!.id}")]`);
  expect(tool!.content).toBe(res);
  // A stub carries nothing that changes between requests — the same input, the same text.
  expect(bulkyItems(api, 4096).map((i) => i.stub)).toEqual(items.map((i) => i.stub));
});

test('a stub is deterministic where the meta is missing, and an image without a size says its name alone', () => {
  const api: ChatMessage[] = [
    { role: 'user', content: 'x', images: [image({ width: undefined, height: undefined })] },
    { role: 'shell', content: 'The person ran a shell command in /w:\n$ ls\n(exit 0 · 0.1 s)\n```\na\nb\n```' },
    { role: 'tool', tool_call_id: 'orphan', content: `OK: ${big(5000)}` }, // its call is not in the history
  ];
  const [img, sh, res] = bulkyItems(api, 4096);
  expect(img!.stub).toBe('[image shot.png — recall("img:aaaaaaaa")]');
  expect(sh!.stub).toBe(`[$ ls — 7 lines — recall("${sh!.id}")]`);
  expect(res!.stub).toBe(`[tool result — 500 lines — recall("${res!.id}")]`);
});

test('a recall\'s own result is stubbed as a pointer back to the item it recalled, not as a new item to recall', () => {
  const api: ChatMessage[] = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'recall', arguments: '{"id":"out:7d41e0aa"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: `OK: [recalled out:7d41e0aa — 120 lines]\n${big(5000)}` },
  ];
  const [res] = bulkyItems(api, 4096);
  // The count is this result's own — the header and the content it carried.
  expect(res!.stub).toBe('[recalled out:7d41e0aa — 501 lines — recall("out:7d41e0aa")]');
});

test('the batch: fires past the threshold or every N turns, takes every eligible item at once, and changes nothing otherwise', () => {
  const limits = { enabled: true, threshold: 0.5, minChars: 4096, everyTurns: 3 };
  const items = [{ id: 'img:1', hash: '1', kind: 'img' as const, stub: '', chars: 0, lines: 0 }, { id: 'out:2', hash: '2', kind: 'out' as const, stub: '', chars: 0, lines: 0 }];
  const s = createRecallState();
  expect(decideBatch(s, items, 0.1, limits)).toBe(false); // turn 1: under the threshold, not the Nth turn
  expect(s.stubbed.size).toBe(0);
  expect(decideBatch(s, items, 0.6, limits)).toBe(true); // over the threshold: both at once
  expect([...s.stubbed]).toEqual(['img:1', 'out:2']);
  expect(s.turns).toBe(0);
  // Over the threshold again with nothing new: no change, so the prefix stays.
  expect(decideBatch(s, items, 0.6, limits)).toBe(false);
  // Every third turn: a new item waits two turns under the threshold, then goes.
  const more = [...items, { id: 'res:3', hash: '3', kind: 'res' as const, stub: '', chars: 0, lines: 0 }];
  expect(decideBatch(s, more, 0.1, limits)).toBe(false);
  expect(decideBatch(s, more, 0.1, limits)).toBe(false);
  expect(decideBatch(s, more, 0.1, limits)).toBe(true);
  expect(s.stubbed.has('res:3')).toBe(true);
  // Off: never.
  const off = createRecallState();
  expect(decideBatch(off, items, 0.9, { ...limits, enabled: false })).toBe(false);
  // everyTurns 0 — the threshold alone.
  const t = createRecallState();
  for (let i = 0; i < 20; i++) expect(decideBatch(t, items, 0.1, { ...limits, everyTurns: 0 })).toBe(false);
});

test('the state saves as plain lists and loads back; anything odd in a saved file is dropped', () => {
  const s = createRecallState({ stubbed: ['img:1', 7, 'out:2'], turns: 4 });
  expect([...s.stubbed]).toEqual(['img:1', 'out:2']);
  expect(s.turns).toBe(4);
  expect(saveRecallState(s)).toEqual({ stubbed: ['img:1', 'out:2'], turns: 4 });
  expect(createRecallState({ stubbed: 'no', turns: -1 })).toMatchObject({ turns: 0 });
  expect(createRecallState(undefined).stubbed.size).toBe(0);
});

test('applyRecall: a stubbed image leaves its message as text, a stubbed output and result become their stubs, the rest is untouched', () => {
  const ref = image();
  const out = 'The person ran a shell command in /w:\n$ brew update\n(exit 0 · 24.7 s)\n```\n' + big(1200) + '\n```';
  const res = `OK: ${big(5000)}`;
  const api: ChatMessage[] = [
    { role: 'user', content: 'look [Image #1]', images: [ref] },
    { role: 'assistant', content: 'A screenshot.' },
    { role: 'shell', content: out, shell: { command: 'brew update', outcome: 'exit 0', ms: 24_700, lines: 120 } },
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: res },
    { role: 'assistant', content: 'Done.' },
  ];
  const items = bulkyItems(api, 4096);
  const history = apiHistory(api);
  // Nothing stubbed: what apiHistory gave, as it was (the same objects).
  expect(applyRecall(history, items, new Set())).toEqual(history);
  const all = applyRecall(history, items, new Set(items.map((i) => i.id)));
  expect(all[0]).toEqual({ role: 'user', content: `look [Image #1]\n${items[0]!.stub}` });
  expect('images' in all[0]!).toBe(false);
  expect(all[2]).toEqual({ role: 'user', content: items[1]!.stub });
  expect(all[5]).toEqual({ role: 'tool', tool_call_id: 'c1', content: items[2]!.stub });
  expect(all[1]).toBe(history[1]);
  expect(all[3]).toBe(history[3]);
  // Half of it: only the named ids go.
  const some = applyRecall(history, items, new Set([items[1]!.id]));
  expect(some[0]).toBe(history[0]);
  expect(some[2]!.content).toBe(items[1]!.stub);
  expect(some[5]).toBe(history[5]);
  // The history handed in is never changed.
  expect(history[0]!.images).toEqual([ref]);
});

test('applyRecall: a message with two images keeps the one that is not stubbed as an image', () => {
  const a = image({ n: 1, sha256: 'a'.repeat(64) }), b = image({ n: 2, name: 'two.png', sha256: 'b'.repeat(64), width: 10, height: 5 });
  const api: ChatMessage[] = [{ role: 'user', content: '[Image #1] [Image #2]', images: [a, b] }];
  const items = bulkyItems(api, 4096);
  const [m] = applyRecall(apiHistory(api), items, new Set([items[1]!.id]));
  expect(m).toEqual({ role: 'user', content: '[Image #1] [Image #2]\n[image two.png · 10×5 — recall("img:bbbbbbbb")]', images: [a] });
});

test('findItem: the id, any unique prefix, the hash alone; an ambiguous prefix names the candidates', () => {
  const items = [
    { id: 'out:7d41e0aa', hash: '7d41e0aa', kind: 'out' as const, stub: '[$ a]', chars: 1, lines: 1 },
    { id: 'out:7d99ffff', hash: '7d99ffff', kind: 'out' as const, stub: '[$ b]', chars: 1, lines: 1 },
    { id: 'res:c02b9f15', hash: 'c02b9f15', kind: 'res' as const, stub: '[r]', chars: 1, lines: 1 },
  ];
  expect(findItem(items, 'out:7d41e0aa')).toEqual({ ok: true, item: items[0] });
  expect(findItem(items, 'out:7d4')).toEqual({ ok: true, item: items[0] });
  expect(findItem(items, 'c02b')).toEqual({ ok: true, item: items[2] });
  expect(findItem(items, 'res')).toEqual({ ok: true, item: items[2] });
  const amb = findItem(items, 'out:7d');
  expect(amb.ok).toBe(false);
  if (!amb.ok) expect(amb.error).toBe('"out:7d" matches more than one item: out:7d41e0aa [$ a]; out:7d99ffff [$ b] — give more of the id');
  const none = findItem(items, 'img:1');
  expect(none.ok).toBe(false);
  if (!none.ok) expect(none.error).toContain('nothing in the conversation matches "img:1"');
  expect(findItem(items, '').ok).toBe(false);
});

test('recallResult: text comes back whole under a header; an image comes back as an image, or says why not', () => {
  const out = 'The person ran a shell command in /w:\n$ ls\n(exit 0 · 0.1 s)\n```\na\nb\n```';
  const [sh] = bulkyItems([{ role: 'shell', content: out, shell: { command: 'ls', outcome: 'exit 0', ms: 100, lines: 2 } }], 10);
  expect(recallResult(sh!, {})).toEqual({ ok: true, text: `[recalled ${sh!.id} — 7 lines]\n${out}` });
  const ref = image();
  const [img] = bulkyItems([{ role: 'user', content: 'x', images: [ref] }], 10);
  expect(recallResult(img!, { resolveImage: () => ({ ok: true, url: 'data:image/png;base64,AAAA' }) })).toEqual({
    ok: true, text: `[recalled ${img!.id} — shot.png · 3384×2078 — sent as an image beside this result, for this turn]`, image: { ref, url: 'data:image/png;base64,AAAA' },
  });
  expect(recallResult(img!, { resolveImage: () => ({ ok: false, why: 'missing' }) })).toEqual({ ok: false, error: 'the image shot.png is no longer at /tmp/shot.png' });
  expect(recallResult(img!, { resolveImage: () => ({ ok: false, why: 'changed' }) })).toEqual({ ok: false, error: 'the image shot.png has changed on disk since it was attached' });
  expect(recallResult(img!, { resolveImage: () => ({ ok: false, why: 'off' }) })).toEqual({ ok: false, error: 'images are off on this machine (ai.images.enabled is false)' });
  expect(recallResult(img!, {})).toEqual({ ok: false, error: 'no image can be sent from here' });
});

test('the /context line: counts, singular and plural, nothing when there is nothing to say', () => {
  expect(recallLine(0, 0)).toBe('');
  expect(recallLine(1, 0)).toBe('recall: 1 item stubbed · none recalled this turn');
  expect(recallLine(3, 2)).toBe('recall: 3 items stubbed · 2 recalled this turn');
  expect(recallLine(0, 1)).toBe('recall: nothing stubbed · 1 recalled this turn');
});
