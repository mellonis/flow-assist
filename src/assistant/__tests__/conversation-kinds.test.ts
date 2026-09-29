// A conversation's kind and who can answer it: a policy that asks cannot be given where
// nobody can answer; a one-shot turn is handed no screen, no round boundary, no recall,
// no ask_user, and withholds the tools with nowhere to deliver; `fresh` reads the
// project's instructions; `restore` opens a saved session.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Conversation } from '../conversation.ts';
import { ONESHOT_WITHHELD } from '../conversation-turn.ts';
import { SESSION_VERSION, newSessionId, sessionFingerprint, saveSession } from '../sessions.ts';
import { fakeDeps } from './conversation-deps.ts';

// A model that answers at once and keeps what it was handed.
function answering(text: string) {
  const seen: Record<string, any>[] = [];
  const chatLLM = (async (_wire: unknown, o: Record<string, any>) => {
    seen.push(o);
    o.onLiveCommit?.(text, true);
    return { content: text, transcript: [{ role: 'assistant', content: text }], toolRuns: [] };
  }) as never;
  return { seen, chatLLM };
}

test('I3: a conversation that asks cannot be made where nobody can answer — by fresh, by restore, or bare', () => {
  const deps = { ...fakeDeps(), canAsk: false };
  expect(() => Conversation.fresh(deps, { kind: 'oneshot', policy: { kind: 'ask' } })).toThrow(/nobody to ask/);
  expect(() => new Conversation(deps)).toThrow(/nobody to ask/);
  const now = new Date().toISOString();
  const s = { version: SESSION_VERSION, id: newSessionId(), title: '', createdAt: now, updatedAt: now, messages: [], api: [], summary: '', plan: [], usage: null, prompts: [], draft: '' } as never;
  expect(() => Conversation.restore(deps, s, { rev: 0, mtimeMs: 0, size: 0 }, os.tmpdir())).toThrow(/nobody to ask/);
  const c = Conversation.fresh(deps, { kind: 'oneshot', policy: { kind: 'none' } });
  expect(c.kind).toBe('oneshot');
  expect(c.policy).toEqual({ kind: 'none' });
});

test('a one-shot turn: no screen tail, no round boundary, no recall, no ask_user, its own plan, the withheld tools, no confirmWrite under none', async () => {
  const m = answering('Done.');
  const c = Conversation.fresh({ ...fakeDeps({ chatLLM: m.chatLLM, screen: () => [{ label: 'board', text: 'ON SCREEN' }] as never }), canAsk: false }, { kind: 'oneshot', policy: { kind: 'none' } });
  expect(await c.send('go')).toBe(true);
  const o = m.seen[0]!;
  expect(o.requestTail).toBeUndefined();
  expect(o.beforeRequest).toBeUndefined();
  expect(o.toolCtx.recall).toBeUndefined();
  expect(o.toolCtx.askUser).toBeUndefined();
  expect(o.toolCtx.plan).toBe(c.plan);
  expect(o.withholdTools).toEqual(ONESHOT_WITHHELD);
  expect(o.confirmWrite).toBeUndefined();
  expect(c.lastEnd).toMatchObject({ kind: 'turn', outcome: 'answer' });
  expect(c.lastAnswer()).toBe('Done.');
});

test('a chat\'s session turn keeps what it had: the screen tail, the boundary, recall, ask_user, a y/n, nothing withheld', async () => {
  const m = answering('Done.');
  const c = new Conversation(fakeDeps({ chatLLM: m.chatLLM }));
  await c.send('go');
  const o = m.seen[0]!;
  expect(typeof o.requestTail).toBe('function');
  expect(typeof o.beforeRequest).toBe('function');
  expect(typeof o.toolCtx.recall.items).toBe('function');
  expect(typeof o.toolCtx.askUser).toBe('function');
  expect(typeof o.confirmWrite).toBe('function');
  expect(o.withholdTools).toEqual([]);
});

test('a session turn where nobody can answer is handed no ask_user, so no question waits on nobody', async () => {
  const m = answering('Done.');
  const c = Conversation.fresh({ ...fakeDeps({ chatLLM: m.chatLLM }), canAsk: false }, { kind: 'session', policy: { kind: 'none' } });
  await c.send('go');
  expect(m.seen[0]!.toolCtx.askUser).toBeUndefined();
});

test('the settings-file guard never asks where nobody can answer', async () => {
  let checked = 0;
  const services = { configChanges: { check: () => { checked++; return [{ file: 'config.json', lines: ['ai.model: a → b'] }]; }, apply: () => ({ applied: [], restart: [] }), decline: () => null } };
  const c = Conversation.fresh({ ...fakeDeps({ services: () => services }), canAsk: false }, { kind: 'oneshot', policy: { kind: 'none' } });
  await c.askConfigChanges();
  expect(checked).toBe(0);
  expect(c.confirm).toBeNull();
});

test('fresh reads the project\'s instructions for the start directory; the first request\'s system prompt carries them', async () => {
  const m = answering('ok');
  const deps = { ...fakeDeps({ chatLLM: m.chatLLM }), canAsk: false };
  const root = (deps.config().shell as { roots: string[] }).roots[0]!;
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'KINDS-INSTRUCTIONS: tabs, never spaces.\n');
  const c = Conversation.fresh(deps, { kind: 'oneshot', policy: { kind: 'none' } });
  expect(c.project.files.map((f) => path.basename(f.path))).toEqual(['AGENTS.md']);
  await c.send('go');
  expect(String(m.seen[0]!.systemPrompt())).toContain('KINDS-INSTRUCTIONS');
});

test('restore opens a saved session into a conversation of its own', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-kinds-')));
  const now = new Date().toISOString();
  const id = newSessionId();
  saveSession(dir, { version: SESSION_VERSION, id, title: 'kept', createdAt: now, updatedAt: now, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }], api: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }], summary: '', plan: [], usage: null, prompts: ['q'], draft: '' } as never);
  const c = Conversation.restore({ ...fakeDeps({ sessionsDir: () => dir }), canAsk: true }, JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')), sessionFingerprint(dir, id), dir);
  expect(c.sessionId).toBe(id);
  expect(c.title).toBe('kept');
  expect(c.lastAnswer()).toBe('a');
  expect(c.policy).toEqual({ kind: 'ask' });
});
