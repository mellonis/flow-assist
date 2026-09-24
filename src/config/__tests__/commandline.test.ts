import { expect, test } from 'bun:test';
import { lineTab, lineView, type TabWalk } from '../commandline';
import { BASE_COMMANDS, completeCommand } from '../commands';

const complete = (text: string) => completeCommand(text, BASE_COMMANDS, {});

test('the untyped rest of the best match is offered after the caret', () => {
  const v = lineView('he', null, complete);
  expect(`he${v.ghost}`).toBe('help');
  // Nothing typed → nothing offered: the full command list is noise.
  expect(lineView('', null, complete)).toEqual({ ghost: '', label: '', others: [] });
  // A whole command has nothing left to offer.
  expect(lineView('help', null, complete).ghost).toBe('');
});

test('Tab takes the offer, then walks the other candidates and comes back round', () => {
  const start = 'c';
  const all = complete(start).candidates;
  expect(all.length).toBeGreaterThan(1);
  let input = start;
  let walk: TabWalk | null = null;
  const seen: string[] = [];
  for (let i = 0; i < all.length + 1; i++) {
    ({ input, walk } = lineTab(input, walk, complete));
    seen.push(input);
  }
  // Every candidate once, in order, then the first again.
  expect(new Set(seen.slice(0, all.length))).toEqual(new Set(all));
  expect(seen[all.length]).toBe(seen[0]!);
  // While walking the line holds a whole candidate: no ghost, the OTHERS are named.
  const v = lineView(input, walk, complete);
  expect(v.ghost).toBe('');
  expect(v.others).not.toContain(input);
  expect(v.others.length).toBe(all.length - 1);
});

test('typing anything ends the walk', () => {
  const first = lineTab('c', null, complete);
  const typed = `${first.input}x`;
  // The stale walk no longer applies: the view is computed from the line as it is.
  expect(lineView(typed, first.walk, complete)).toEqual(lineView(typed, null, complete));
});

test('Tab replaces the WORD being completed, not everything before the first space', () => {
  // Completing the whole line instead of just the word would give `config ge` + Tab → `get ge`.
  expect(lineTab('config ge', null, complete).input).toBe('config get');
  expect(lineView('config ge', null, complete).ghost).toBe('t');
  // A config key is completed in place too.
  const key = lineTab('config get ai.mod', null, (t) => completeCommand(t, BASE_COMMANDS, { ai: { model: 'x' } }));
  expect(key.input).toBe('config get ai.model');
});

test('Tab with nothing to offer changes nothing', () => {
  expect(lineTab('zzzz', null, complete)).toEqual({ input: 'zzzz', walk: null });
  expect(lineTab('', null, complete)).toEqual({ input: '', walk: null });
});

test('a labelled candidate is said beside the field, and the others carry their labels', () => {
  const labelled = (text: string) => {
    const head = text.replace(/^open ?/, '');
    const all = ['1', '2', '3'].filter((c) => c.startsWith(head));
    return { head, hasSpace: true, best: all.find((c) => c !== head) ?? all[0] ?? '', candidates: all, labels: { '1': 'first', '2': 'second' } };
  };
  expect(lineView('open ', null, labelled)).toEqual({ ghost: '1', label: 'first', others: ['2 second', '3'] });
  // Typed by hand, the whole word still says what it names.
  expect(lineView('open 2', null, labelled)).toMatchObject({ ghost: '', label: 'second' });
  // Walking: the label follows the candidate the line holds.
  const first = lineTab('open ', null, labelled);
  const second = lineTab(first.input, first.walk, labelled);
  expect(second.input).toBe('open 2');
  expect(lineView(second.input, second.walk, labelled)).toEqual({ ghost: '', label: 'second', others: ['1 first', '3'] });
  // No labels: the view says nothing beside the field.
  expect(lineView('he', null, complete).label).toBe('');
});

test('a walk over a single candidate completes anew: Tab after a unique directory walks into it', () => {
  // A completer over a small tree: `a` → `a/`, then `a/` → `a/b/`.
  const tree = (text: string) => {
    const word = text.split(' ').at(-1)!;
    const all = word.startsWith('a/') ? ['a/b/'] : ['a/'].filter((c) => c.startsWith(word));
    return { head: word, hasSpace: true, best: all[0] ?? '', candidates: all };
  };
  const first = lineTab('cd a', null, tree);
  expect(first.input).toBe('cd a/');
  expect(lineTab(first.input, first.walk, tree).input).toBe('cd a/b/');
});
