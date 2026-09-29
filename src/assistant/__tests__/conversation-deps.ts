import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConversationDeps } from '../conversation-types.ts';

// A host with nothing behind it: no sessions directory, a memory file and a workspace
// root of its own (the memory's facts are read from the workspace: one
// root per conversation keeps one test's facts out of the next), a shell root of its own
// (an empty directory: nothing in the system's temporary directory is read), and a model
// that must not be asked unless a test says so.
export function fakeDeps(over: Partial<ConversationDeps> = {}): ConversationDeps & { notified: () => number; log: string[] } {
  let notified = 0;
  const log: string[] = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-conv-'));
  // By its real path: the shell compares roots by it, and the temporary directory may be
  // a symbolic link (macOS).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-conv-root-')));
  const config: Record<string, unknown> = { ai: {}, memory: { file: path.join(home, 'memory.json') }, workspace: { dir: path.join(home, 'projects') }, shell: { roots: [root] } };
  return {
    config: () => config, services: () => ({}),
    chatLLM: async () => { throw new Error('no model in this test'); },
    compact: (async () => { throw new Error('no compaction in this test'); }) as never,
    pluginAiTools: () => [], pluginToken: undefined, viewRenderers: () => ({}), screen: () => [],
    afterWrite: () => {}, notify: () => { notified++; }, showMessage: () => {}, pushLog: (l) => { log.push(l); },
    sessionsDir: () => null, lockToken: 'test-token', screens: () => undefined,
    canAsk: true,
    ...over, notified: () => notified, log,
  };
}
