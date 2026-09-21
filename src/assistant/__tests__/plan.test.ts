import { expect, test } from 'bun:test';
import { createPlan } from '../plan';
import { assembleToolRegistry, execChatTool } from '../../loader/tools';

test('a plan is its own: two of them never see each other', () => {
  const a = createPlan();
  const b = createPlan();
  a.exec({ action: 'add', items: ['read the diff', 'run the tests'] });
  expect(a.snapshot().map((t) => t.text)).toEqual(['read the diff', 'run the tests']);
  expect(b.snapshot()).toEqual([]);
  // Ids are per plan too.
  b.exec({ action: 'add', text: 'unrelated' });
  expect(b.snapshot()[0]!.id).toBe(1);
});

test('reset empties the plan and restarts its ids', () => {
  const plan = createPlan();
  plan.exec({ action: 'add', items: ['one', 'two'] });
  plan.reset();
  expect(plan.snapshot()).toEqual([]);
  plan.exec({ action: 'add', text: 'fresh' });
  expect(plan.snapshot()).toEqual([{ id: 1, text: 'fresh', status: 'pending' }]);
});

test('a snapshot is a copy: a renderer cannot change the plan', () => {
  const plan = createPlan();
  plan.exec({ action: 'add', text: 'one' });
  plan.snapshot()[0]!.status = 'done';
  expect(plan.snapshot()[0]!.status).toBe('pending');
});

test('notify fires on a change and not on a read', () => {
  const plan = createPlan();
  let n = 0;
  plan.exec({ action: 'list' }, () => n++);
  expect(n).toBe(0);
  plan.exec({ action: 'add', text: 'one' }, () => n++);
  plan.exec({ action: 'start', text: 'one' }, () => n++);
  expect(n).toBe(2);
});

test('the todo tool writes to the plan in its context, not to a shared one', async () => {
  // `execChatTool` dispatches through the registry singleton: assemble it HERE. The
  // test used to lean on some earlier test file having done so, and failed alone.
  assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as never });
  const mine = createPlan();
  const theirs = createPlan();
  await execChatTool('todo', { action: 'add', text: 'mine' }, { plan: mine });
  await execChatTool('todo', { action: 'add', text: 'theirs' }, { plan: theirs });
  expect(mine.snapshot().map((t) => t.text)).toEqual(['mine']);
  expect(theirs.snapshot().map((t) => t.text)).toEqual(['theirs']);
});
