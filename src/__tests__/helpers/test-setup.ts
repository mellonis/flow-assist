// Loaded before every test file (bunfig.toml, `preload`). The host's state is one
// temporary directory for the whole `bun test` process (`hostStateDir`), and the plugin
// trust record and the memory record run their first start once per record
// (src/loader/trust.ts, src/assistant/memory-trust.ts). Every test starts as a machine
// that has never started the host: without a record, so one test's first start is not
// the next test's, whose plugins and facts would all read as put there from outside.
//
// A repeat of a failed model request waits seconds (src/assistant/llm-retry.ts); no test
// waits for them. The wait resolves at once unless a test sets its own `retryClock.sleep`
// (the ones that end a wait by an abort use the real one, `sleepFor`).
retryClock.sleep = async () => {};
import { afterEach, beforeEach } from 'bun:test';
import fs from 'node:fs';
import { drainDisposables } from './disposal.ts';
import { pluginTrustPath } from '../../loader/trust.ts';
import { memoryTrustPath } from '../../assistant/memory-trust.ts';
import { retryClock } from '../../assistant/llm-retry.ts';

// The real fetch, snapshotted before any test module loads: a test's restore target.
// A test that leaves the scripted mock installed would otherwise hand the next file a
// double to capture as "the real one".
export const nativeFetch = globalThis.fetch;

// The hooks register where there is a test runner to register with. The helpers are
// also reachable from a plain `bun` script — the signal-exit host boots the real app
// through `helpers/scripted.ts` — and `bun:test`'s hooks have nothing to attach to
// there.
try {
  beforeEach(() => {
    fs.rmSync(pluginTrustPath(), { force: true });
    fs.rmSync(memoryTrustPath(), { force: true });
  });

  afterEach(async () => {
    await drainDisposables();
  });
} catch {
  // Not a `bun test` run: no per-test isolation to install.
}
