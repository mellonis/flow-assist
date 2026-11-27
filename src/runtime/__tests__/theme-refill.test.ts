// The app resolves its palette from both schemes' models built at start; a scheme
// flip refills the theme object every plugin and renderer was handed, never a new one.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle, settleUntil } from '../../__tests__/helpers/scripted';
import { fakeRemote } from '../../__tests__/helpers/remote-fake';
import { resetSessionConfig } from '../../config/load';

import { nativeFetch } from '../../__tests__/helpers/test-setup.ts';
const realFetch = nativeFetch;
afterEach(() => { globalThis.fetch = realFetch; resetSessionConfig(); });

type Resolved = { base: Record<string, string>; chat: Record<string, string> };

test('a system-mode app on a light terminal flipping to dark refills the same theme object', async () => {
  const theme = { dark: { chat: { userBg: '#010203' } } };
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, { ui: { theme: 'system' }, theme }, { scheme: 'light' });
  const held = ui.config.theme as Resolved;
  expect(held.base.bg).toBe('#f4f4f6');
  expect(held.chat.userBg).toBe('#e4e4f0');

  ui.backend.setColorScheme('dark', '#000000');
  await settle();
  expect(ui.config.theme).toBe(held);
  expect(held.base.bg).toBe('black');
  expect(held.chat.userBg).toBe('#010203');
  ui.app.unmount();
});

test('a theme still in the old format is said once at start, and not applied', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, { theme: { modals: { bg: 'red' }, dark: { base: { bg: 'nope' } } } });
  const lines = ui.services.log.read();
  expect(lines.filter((l) => l.includes('theme.modals from the old format is not applied — flow-assist config migrate-theme moves it'))).toHaveLength(1);
  expect(lines.filter((l) => l.includes('theme.dark.base.bg'))).toHaveLength(1);
  expect((ui.config.theme as Resolved).base.bg).toBe('black');
  ui.app.unmount();
});

test('a plugin that joins after start gets its surface on the same theme object', async () => {
  const fake = fakeRemote({ keys: { open: 'S' }, entry: ['open'], colors: { lane: '${highlightBg}' } });
  fake.holdHello();
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, { theme: { dark: { fake: { mark: 'red' } } } }, { late: true, remote: { manifest: fake.manifest, transport: fake.transport } });
  const held = ui.config.theme as Record<string, Record<string, string>>;
  expect(held.fake?.lane).toBeUndefined();
  fake.answerHello();
  await settleUntil(() => held.fake?.lane !== undefined, 200, 'the late plugin\'s surface');
  expect(ui.config.theme).toBe(held);
  expect(held.fake!.lane).toBe('#3c3c3c');
  // The person's overrides survive the rebuild.
  expect(held.fake!.mark).toBe('red');
  ui.app.unmount();
});
