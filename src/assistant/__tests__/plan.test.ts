import { expect, test } from 'bun:test';
import { createPlan, planReminder } from '../plan';
import { assembleToolRegistry, chatToolDefs, execChatTool } from '../../loader/tools';
import { toolArgsError } from '../tool-args';

test('a plan is its own: two of them never see each other', () => {
  const a = createPlan();
  const b = createPlan();
  a.exec({ action: 'add', items: ['read the diff', 'run the tests'] });
  expect(a.snapshot().map((t) => t.text)).toEqual(['read the diff', 'run the tests']);
  expect(b.snapshot()).toEqual([]);
  // Ids are per plan too.
  b.exec({ action: 'add', text: 'unrelated' });
  expect(b.snapshot()[0]!.id).toBe('t1');
});

test('reset empties the plan and restarts its ids', () => {
  const plan = createPlan();
  plan.exec({ action: 'add', items: ['one', 'two'] });
  plan.reset();
  expect(plan.snapshot()).toEqual([]);
  plan.exec({ action: 'add', text: 'fresh' });
  expect(plan.snapshot()).toEqual([{ id: 't1', text: 'fresh', status: 'pending' }]);
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
  // `execChatTool` dispatches through the registry singleton: assemble it HERE, so
  // this test does not depend on an earlier test file having done so and cannot fail
  // when run alone.
  assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as never });
  const mine = createPlan();
  const theirs = createPlan();
  await execChatTool('todo', { action: 'add', text: 'mine' }, { plan: mine });
  await execChatTool('todo', { action: 'add', text: 'theirs' }, { plan: theirs });
  expect(mine.snapshot().map((t) => t.text)).toEqual(['mine']);
  expect(theirs.snapshot().map((t) => t.text)).toEqual(['theirs']);
});

test('the model reads the plan in its own order, each item by its id and state', () => {
  const plan = createPlan();
  plan.exec({ action: 'add', items: ['read the diff', 'run the tests', 'write the summary'] });
  plan.exec({ action: 'complete', id: 't3' });
  plan.exec({ action: 'start', text: 'run the tests' });
  // Plan order, never grouped by state; ids, never a position on screen.
  expect(plan.exec({ action: 'list' })).toBe([
    '☐ t1 · read the diff (pending)',
    '⊟ t2 · run the tests (in progress)',
    '☑ t3 · write the summary (done)',
  ].join('\n'));
});

test('a replaced plan starts its ids fresh; items kept by text keep theirs', () => {
  const plan = createPlan();
  plan.exec({ action: 'add', items: ['a', 'b', 'c', 'd', 'e'] });
  plan.exec({ action: 'set', todos: [{ text: 'b', status: 'done' }, { text: 'x' }] });
  // b keeps t2; the new item takes the next id of THIS plan.
  expect(plan.snapshot().map((t) => t.id)).toEqual(['t2', 't6']);
  // A list that shares no item with the plan is a new plan: t1 again.
  plan.exec({ action: 'set', todos: [{ text: 'first' }, { text: 'second' }] });
  expect(plan.snapshot().map((t) => t.id)).toEqual(['t1', 't2']);
});

test('ids are never reused within a plan', () => {
  const plan = createPlan();
  plan.exec({ action: 'add', items: ['a', 'b'] });
  plan.exec({ action: 'remove', id: 't2' });
  plan.exec({ action: 'add', text: 'c' });
  expect(plan.snapshot().map((t) => t.id)).toEqual(['t1', 't3']);
});

test('an item is found by its exact text, not by a fragment of it', () => {
  const plan = createPlan();
  plan.exec({ action: 'add', items: ['item 32', 'item 33'] });
  expect(plan.exec({ action: 'start', text: '33' })).toContain('not found');
  expect(plan.exec({ action: 'start', text: 'Item 33' })).toContain('t2 · item 33 (in progress)');
});

test('a plan saved with numeric ids loads, and the model may still name them by number', () => {
  const plan = createPlan();
  plan.load([{ id: 5, text: 'old five', status: 'pending' }, { id: 7, text: 'old seven', status: 'completed' }]);
  expect(plan.snapshot()).toEqual([
    { id: 't5', text: 'old five', status: 'pending' },
    { id: 't7', text: 'old seven', status: 'done' },
  ]);
  expect(plan.exec({ action: 'start', id: 5 })).toContain('t5 · old five (in progress)');
  plan.exec({ action: 'add', text: 'new' });
  expect(plan.snapshot().at(-1)!.id).toBe('t8');
});

test('the reminder is due while work is pending and nothing is in progress', () => {
  const plan = createPlan();
  expect(planReminder(plan)).toBeNull();
  plan.exec({ action: 'add', items: ['a', 'b'] });
  expect(planReminder(plan)).toContain('todo');
  plan.exec({ action: 'start', id: 't1' });
  expect(planReminder(plan)).toBeNull();
  plan.exec({ action: 'set', todos: [{ text: 'a', status: 'done' }, { text: 'b', status: 'done' }] });
  expect(planReminder(plan)).toBeNull();
});

test('the todo schema takes an id as a string or an integer, and a number n names t<n>', () => {
  assembleToolRegistry({ plugins: [], config: {}, repo: { list: async () => [] } as never });
  const def = chatToolDefs().find((t) => t.function.name === 'todo')!;
  expect(toolArgsError('todo', def.function.parameters, { action: 'start', id: 't3' })).toBeNull();
  expect(toolArgsError('todo', def.function.parameters, { action: 'complete', id: 5 })).toBeNull();
  const plan = createPlan();
  plan.exec({ action: 'add', items: ['a', 'b', 'c', 'd', 'e'] });
  expect(plan.exec({ action: 'complete', id: 5 })).toContain('☑ t5 · e (done)');
});
