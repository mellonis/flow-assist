import { expect, test } from 'bun:test';
import { hostDeps, type DepsSource } from '../host-deps.ts';
import { renderConsole } from '../console-view.ts';

const source = (services: Record<string, unknown>, over: Partial<DepsSource> = {}): DepsSource => ({
  config: () => ({}), services: () => services, notify: () => {}, sessionsDir: () => null,
  lockToken: 'tok', canAsk: true, ...over,
});

test('hostDeps: a run with nothing to withhold is handed the options object itself', async () => {
  let seen: unknown = null;
  const opts = { maxRounds: 3 };
  const d = hostDeps(source({ chatLLM: async (_m: unknown, o: unknown) => { seen = o; return { content: '' }; } }));
  await d.chatLLM([], opts as never);
  expect(seen).toBe(opts);
});

test('hostDeps: withheld names come first, then the run\'s own', async () => {
  let seen: { withholdTools?: readonly string[]; maxRounds?: number } = {};
  const d = hostDeps(source({ chatLLM: async (_m: unknown, o: typeof seen) => { seen = o; return { content: '' }; } }, { withhold: ['subagent', 'remind'] }));
  await d.chatLLM([], { maxRounds: 3, withholdTools: ['x'] } as never);
  expect(seen.withholdTools).toEqual(['subagent', 'remind', 'x']);
  expect(seen.maxRounds).toBe(3);
});

test('hostDeps: every member reads the services when it is called, not when the deps are made', () => {
  const services: Record<string, unknown> = {};
  const d = hostDeps(source(services));
  const toasts: string[] = [];
  services.showMessage = (t: string) => { toasts.push(t); };
  services.pluginAiTools = ['late'];
  d.showMessage('hi');
  expect(toasts).toEqual(['hi']);
  expect(d.pluginAiTools()).toEqual(['late']);
});

test('hostDeps: the defaults a bare host gives', () => {
  const d = hostDeps(source({ chatContext: () => { throw new Error('boom'); } }));
  expect(d.screen()).toEqual([]);
  expect(d.pluginAiTools()).toEqual([]);
  expect(d.viewRenderers()).toEqual({ console: renderConsole });
  expect(d.screens()).toBeUndefined();
  expect(() => { d.showMessage('x'); d.pushLog('y'); d.afterWrite(); }).not.toThrow();
  expect([d.lockToken, d.canAsk, d.sessionsDir(), d.pluginToken]).toEqual(['tok', true, null, undefined]);
});

test('hostDeps: current is passed through, and absent when not given', () => {
  expect(hostDeps(source({})).current).toBeUndefined();
  const c = {} as never;
  expect(hostDeps(source({}, { current: () => c })).current?.()).toBe(c);
});
