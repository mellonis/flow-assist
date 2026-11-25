// The pristine fetch, and nothing else. This module is imported by `helpers/scripted.ts`,
// which a plain `bun` process reaches (signal-exit's host boots the app that way), so a
// side effect written here travels there: the per-test hooks and the test-time retry no-op
// live in `preload-hooks.ts`, which only the preload loads (bunfig.toml). The regression is
// pinned by `preload-side-effects.test.ts`.

// The real fetch, snapshotted before any test module loads: a test's restore target.
// A test that leaves the scripted mock installed would otherwise hand the next file a
// double to capture as "the real one".
export const nativeFetch = globalThis.fetch;
