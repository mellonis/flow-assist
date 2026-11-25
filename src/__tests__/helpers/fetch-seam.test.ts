import { expect, test } from 'bun:test';
import { nativeFetch } from './test-setup.ts';
import { ScriptedModel, bootApp, restoreFetch } from './scripted.ts';

// The process-global fetch is a shared cell every test file reads: a test that leaves
// the scripted mock installed hands the NEXT file a double to capture as "the real
// one". Either way a test ends — `close()` or the disposal between tests — the cell
// holds the pristine fetch the preload snapshotted.

test('an install/restore cycle leaves the pristine fetch behind', () => {
  new ScriptedModel().install();
  expect(globalThis.fetch).not.toBe(nativeFetch);
  restoreFetch();
  expect(globalThis.fetch).toBe(nativeFetch);
});

test('close() closes the app and restores the pristine fetch', async () => {
  const ui = await bootApp(new ScriptedModel());
  expect(globalThis.fetch).not.toBe(nativeFetch);
  await ui.close();
  expect(ui.closed).toBe(true);
  expect(globalThis.fetch).toBe(nativeFetch);
});

test('a test leaves its app open on purpose', async () => {
  const ui = await bootApp(new ScriptedModel());
  expect(ui.closed).toBe(false);
  expect(globalThis.fetch).not.toBe(nativeFetch);
});

test('the app the previous test left open was disposed before this one started', () => {
  expect(globalThis.fetch).toBe(nativeFetch);
});
