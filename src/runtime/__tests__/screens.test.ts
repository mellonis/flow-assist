// The screens' rules that need no app (src/runtime/screens.ts): a stopped turn drops
// what it deferred whatever still waits, background work opens nothing, and the model's
// list is bounded.
import { expect, test } from 'bun:test';
import { createScreens } from '../screens';
import { asBackgroundWork } from '../background-work';

type St = { opened: number; asking: boolean; busy: boolean; blocker: string | null };
const one = (st: St) => [{ name: 'a', screens: { main: { entry: true, open: () => { st.opened++; } } } }];
const mk = (plugins: (st: St) => any[] = one) => {
  const st: St = { opened: 0, asking: false, busy: true, blocker: 'a question waits' };
  const s = createScreens({
    plugins: plugins(st),
    builtins: ['core'], disabled: new Set(), untrusted: () => [], starting: () => [], keys: { go: ['G'] }, apiOf: () => ({}),
    busy: () => st.busy, blocker: () => st.blocker, asking: () => st.asking, covered: () => false, notify: () => {}, log: () => {}, say: () => {},
  });
  return { s, st };
};

test('a stopped turn drops what it deferred even while a y/n still waits (a settings question asked as the turn ends)', async () => {
  const m = mk();
  expect((await m.s.uiOpen('a')).deferred).toBe(true);
  m.st.asking = true;
  m.s.afterTurn(false);
  expect(m.s.pending()).toEqual([]);
  m.st.asking = false; m.st.busy = false; m.st.blocker = null;
  m.s.settle();
  await Bun.sleep(1);
  expect(m.st.opened).toBe(0);
});

test('background work opens no screen — through host.open or ui_open', async () => {
  const m = mk();
  m.st.blocker = null; m.st.busy = false;
  const viaTool = await asBackgroundWork(async () => { await Bun.sleep(1); return m.s.open('a', 'main'); });
  expect(viaTool).toEqual({ ok: false, text: 'Not opened: screens are not opened from background work.' });
  expect((await asBackgroundWork(() => m.s.uiOpen('a'))).ok).toBe(false);
  expect(m.st.opened).toBe(0);
  expect((await m.s.uiOpen('a')).ok).toBe(true);
  expect(m.st.opened).toBe(1);
});

test('the model\'s list caps the screens and tools of a line, and the whole block', () => {
  const screens = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`s${i}`, { title: `screen ${i}`, tools: [`open_s${i}`], open: () => undefined }]));
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `plugin${i}`, entry: ['go'], screens }));
  const block = mk(() => many).s.promptBlock();
  const first = block.split('\n').find((l) => l.startsWith('- plugin0 —'))!;
  expect(first).toContain('screen 7, +4 more');
  expect(first).toContain('open_s7, +4 more');
  expect(first).not.toContain('screen 8');
  expect(block.length).toBeLessThan(4600);
  expect(block).toMatch(/- \+\d+ more plugins$/);
});
