// When a `y` or `n` may answer a subagent's y/n (AGENTS.md (subagent y/n)): a pause after
// the request came on screen and a pause after the person's last key. The clock is the
// guard's seam, moved by the tests.
import { afterEach, expect, test } from 'bun:test';
import { ASK_ARM_MS, askClock, createAskGuard } from '../child-ask-guard.ts';

const realNow = askClock.now;
const clock = { t: 1_000 };
afterEach(() => { askClock.now = realNow; });
const guard = () => { clock.t = 1_000; askClock.now = () => clock.t; return createAskGuard(); };

test('nothing shown: no key is armed', () => {
  const g = guard();
  clock.t += 10 * ASK_ARM_MS;
  expect(g.press()).toBe(false);
});

test('a request counts only after the pause since it was shown', () => {
  const g = guard();
  const r = {};
  g.show(r);
  clock.t += ASK_ARM_MS - 1;
  expect(g.press()).toBe(false);
  clock.t += 10 * ASK_ARM_MS;
  expect(g.press()).toBe(true);
});

test('a key resets the pause for the next one, and is read as of before it', () => {
  const g = guard();
  g.show({});
  clock.t += 2 * ASK_ARM_MS;
  expect(g.press()).toBe(true);
  clock.t += ASK_ARM_MS - 1;
  expect(g.press()).toBe(false);
  clock.t += ASK_ARM_MS;
  expect(g.press()).toBe(true);
});

test('a key the host took first (note) is a keystroke too', () => {
  const g = guard();
  g.show({});
  clock.t += 2 * ASK_ARM_MS;
  g.note();
  clock.t += ASK_ARM_MS - 1;
  expect(g.press()).toBe(false);
});

test('showing the same request again does not re-arm it', () => {
  const g = guard();
  const r = {};
  g.show(r);
  clock.t += 2 * ASK_ARM_MS;
  g.show(r);
  expect(g.press()).toBe(true);
});

test('a different request arms from the moment it is shown', () => {
  const g = guard();
  g.show({});
  clock.t += 2 * ASK_ARM_MS;
  g.show({});
  expect(g.press()).toBe(false);
  clock.t += 2 * ASK_ARM_MS;
  expect(g.press()).toBe(true);
});

test('after show(null) the same request arms afresh', () => {
  const g = guard();
  const r = {};
  g.show(r);
  clock.t += 2 * ASK_ARM_MS;
  g.show(null);
  expect(g.press()).toBe(false);
  clock.t += 2 * ASK_ARM_MS;
  g.show(r);
  clock.t += ASK_ARM_MS - 1;
  expect(g.press()).toBe(false);
  clock.t += 2 * ASK_ARM_MS;
  expect(g.press()).toBe(true);
});
