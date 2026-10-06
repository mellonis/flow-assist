// A screen is opened for the session whose work asks (src/runtime/background-work.ts,
// src/runtime/screens.ts): none for a session the person left, and what one deferred goes
// when it is left.
import { expect, test } from 'bun:test';
import { createScreens } from '../screens';
import { asBackgroundWork, asConversationWork, inUnattachedWork, workOwner } from '../background-work';

type St = { opened: string[]; blocker: string | null; log: string[] };
const mk = () => {
  const st: St = { opened: [], blocker: null, log: [] };
  const plugin = (name: string) => ({ name, screens: { main: { entry: true, open: () => { st.opened.push(name); } } } });
  const s = createScreens({
    plugins: [plugin('a'), plugin('b')] as never,
    builtins: ['core'], disabled: new Set(), untrusted: () => [], starting: () => [], keys: { go: ['G'] }, apiOf: () => ({}),
    busy: () => true, blocker: () => st.blocker, asking: () => false, covered: () => false, notify: () => {}, log: (line) => { st.log.push(line); }, say: () => {},
  });
  return { s, st };
};

test('a turn of a conversation nobody draws opens no screen; attached again, the same turn may', async () => {
  const { s, st } = mk();
  const conv = { attached: false, kind: 'session' };
  await asConversationWork(conv, async () => {
    await Bun.sleep(1);
    expect(workOwner()).toBe(conv);
    expect(await s.uiOpen('a')).toEqual({ ok: false, text: 'Not opened: this session is not on screen — the person is in another one.' });
    expect(await s.open('b', 'main')).toEqual({ ok: false, text: 'Not opened: this session is not on screen — the person is in another one.' });
    expect(st.opened).toEqual([]);
    // Taken back while the turn runs: asked again at the next call.
    conv.attached = true;
    await Bun.sleep(1);
    expect((await s.uiOpen('a')).ok).toBe(true);
    expect(st.opened).toEqual(['a']);
  });
  expect(workOwner()).toBeUndefined();
});

test('a screen a conversation deferred is dropped when it is left; one deferred with no owner stays', async () => {
  const { s, st } = mk();
  st.blocker = 'a question waits';
  const conv = { attached: true, kind: 'session' };
  const other = { attached: true, kind: 'session' };
  expect((await asConversationWork(conv, () => s.uiOpen('a'))).deferred).toBe(true);
  // A plugin's own key: nobody's turn.
  expect((await s.open('b', 'main')).deferred).toBe(true);
  expect(s.pending()).toEqual(['a:main', 'b:main']);
  s.dropFor(other);
  expect(s.pending()).toEqual(['a:main', 'b:main']);
  s.dropFor(conv);
  expect(s.pending()).toEqual(['b:main']);
  expect(st.log).toContain('[screens] a:main not opened — its session was left');
  expect(st.log.filter((l) => l.includes('its session was left'))).toHaveLength(1);
  s.afterTurn(true);
  await Bun.sleep(1);
  expect(st.opened).toEqual(['b']);
});

test('a task\'s owner opens nothing as background work, with the background text', async () => {
  const { s, st } = mk();
  const task = { attached: false, kind: 'task' };
  const r = await asBackgroundWork(() => asConversationWork(task, async () => { await Bun.sleep(1); return s.open('a', 'main'); }));
  expect(r).toEqual({ ok: false, text: 'Not opened: screens are not opened from background work.' });
  expect(st.opened).toEqual([]);
  // A task is never "a session not on screen": the background mark alone refuses it.
  expect(asConversationWork(task, () => inUnattachedWork())).toBe(false);
});
