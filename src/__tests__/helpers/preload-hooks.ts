// Loaded before every test file (bunfig.toml, `preload`), after test-setup.ts. The host's
// state is one temporary directory for the whole `bun test` process (`hostStateDir`), and
// the plugin trust record and the memory record run their first start once per record
// (src/loader/trust.ts, src/assistant/memory-trust.ts). Every test starts as a machine
// that has never started the host: without a record, so one test's first start is not
// the next test's, whose plugins and facts would all read as put there from outside.
//
// This module is the ONE place a test run installs a process-global or registers a hook,
// and it is a preload only. `helpers/scripted.ts` is reachable from a plain `bun` process
// (signal-exit's host boots the app that way), so a side effect written in a module it
// imports travels there: `bun:test`'s hooks have no runner to attach to, and the test-time
// retry no-op would make a real host retry with no pause. Every side effect lives here,
// where only the preload loads it, and nothing here needs a guard.
import { afterEach, beforeEach } from 'bun:test';
import fs from 'node:fs';
import { drainDisposables } from './disposal.ts';
import { pluginTrustPath } from '../../loader/trust.ts';
import { memoryTrustPath } from '../../assistant/memory-trust.ts';
import { retryClock } from '../../assistant/llm-retry.ts';
import { setActiveSecrets } from '../../assistant/secrets.ts';
import { nativeFetch } from './test-setup.ts';

// A repeat of a failed model request waits seconds (src/assistant/llm-retry.ts); no test
// waits for them. The wait resolves at once unless a test sets its own `retryClock.sleep`
// (the ones that end a wait by an abort use the real one, `sleepFor`).
retryClock.sleep = async () => {};

beforeEach(() => {
  fs.rmSync(pluginTrustPath(), { force: true });
  fs.rmSync(memoryTrustPath(), { force: true });
  // A test starts knowing no secrets. The set an app's boot leaves active
  // (src/assistant/secrets.ts) outlives the test that made it, and a secret of ANOTHER
  // test holds back streamed output here: a tail that could still grow into it is
  // never emitted — a command's single-character chunk being the clearest case.
  setActiveSecrets(null);
  // And with the pristine fetch. Replacing the process's fetch is a test's own act, so
  // a double that outlives its test is a bug and is NAMED — at the start of the test
  // that follows it, which is where it is still visible. (An unnoticed double is what
  // every later capture of "the real one" takes as real — the drift engine of
  // diag-fetch-chain.md.)
  if (globalThis.fetch !== nativeFetch) {
    throw new Error('globalThis.fetch is still replaced at the start of this test: the previous test left a mock installed. Restore it to nativeFetch or close what installed it (`close()` / `closeRigs()`); the seam is helpers/test-setup.ts.');
  }
});

afterEach(async () => {
  await drainDisposables();
});
