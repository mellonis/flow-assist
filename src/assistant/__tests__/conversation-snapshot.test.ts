import { expect, test } from 'bun:test';
import { Conversation } from '../conversation.ts';
import { fakeDeps } from './conversation-deps.ts';

test('the snapshot is one object until something drawn changes, and a change tells the subscriber at once', () => {
  const c = new Conversation(fakeDeps());
  let heard = 0;
  const off = c.subscribe(() => { heard++; });
  const a = c.getSnapshot();
  expect(c.getSnapshot()).toBe(a);
  c.setToolLabel('⚙ x…');
  expect(heard).toBe(1);                 // synchronously, not in a microtask
  const b = c.getSnapshot();
  expect(b).not.toBe(a);
  expect(b.activity.label).toBe('⚙ x…');
  c.setToolLabel('⚙ x…');                // the same value: nothing to draw
  expect(heard).toBe(1);
  expect(c.getSnapshot()).toBe(b);
  c.setRows((cur) => [...cur, { role: 'note', content: 'n' }]);
  c.setRows((cur) => cur);               // an updater that changes nothing
  expect(heard).toBe(2);
  const list = c.getSnapshot().messages;
  c.setToolLabel('⚙ y…');                // a new snapshot around the SAME list: the rows' memo holds
  expect(heard).toBe(3);
  expect(c.getSnapshot().messages).toBe(list);
  off();
  c.setToolLabel('');
  expect(heard).toBe(3);                 // unsubscribed: not told
});

test('the model reads the list as the chat drew it, or the list itself with no chat', () => {
  const c = new Conversation(fakeDeps());
  c.setRows([{ role: 'user', content: 'a' }]);
  expect(c.rows()).toBe(c.messages);
  const drawn = c.messages;
  c.drawnRows = drawn;
  c.setRows((cur) => [...cur, { role: 'note', content: 'b' }]);
  expect(c.rows()).toBe(drawn);
});

const macrotasks = async (n: number) => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r)); };

test('while a turn runs, its changes are told once per macrotask, and a change told at once carries them', async () => {
  const c = new Conversation(fakeDeps());
  let heard = 0;
  c.subscribe(() => { heard++; });
  c.inTurn = true;
  for (let i = 0; i < 5; i++) c.setRows((cur) => [...cur, { role: 'assistant', content: `d${i}` }]);
  c.setPhase('writing');
  expect(heard).toBe(0);
  expect(c.getSnapshot().messages).toHaveLength(5);   // the snapshot itself moved at once
  await macrotasks(3);
  expect(heard).toBe(1);
  // A delta, then the busy mark: the mark is told at once, the delta with it, and the
  // waiting telling finds nothing left.
  c.setRows((cur) => [...cur, { role: 'assistant', content: 'd5' }]);
  c.setBusyDrawn(true);
  expect(heard).toBe(2);
  await macrotasks(3);
  expect(heard).toBe(2);
  // Outside a turn every change is told at once.
  c.inTurn = false;
  c.setPhase('thinking');
  expect(heard).toBe(3);
});
