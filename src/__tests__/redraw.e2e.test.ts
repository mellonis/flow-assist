// A handled key is followed by a redraw — whether or not the plugin asked for one.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// The shape of a real plugin (the tracker's detail screen): ONE component owns the
// state and publishes it on `host.services`; a SIBLING draws it. A React setState in
// the owner re-renders the owner only — the sibling redraws when the host re-renders,
// which the host does after every key it handled, with no `host.notify()` from the
// setter.
const guest = (make: any) => [make('panel', {
  name: 'panel',
  keycaps: () => ['down next'],
  components: {
    // Mounted first: owns the state, handles the key, and calls NO notify().
    owner: (api: any) => function Owner() {
      const [idx, setIdx] = api.ui.useState(0);
      (api.host.services as any).panel = { idx, setIdx };
      api.host.useInputHandler({
        mode: 'consume',
        priority: () => 50,
        handler: (key: { name: string }) => {
          if (key.name !== 'down') return false;
          (api.host.services as any).panel.setIdx((i: number) => i + 1);
          return true;
        },
      });
      return null;
    },
    view: (api: any) => function View() {
      return api.ui.h(api.ui.Text, null, `cursor at ${(api.host.services as any).panel?.idx ?? '?'}`);
    },
  },
})];

test('the screen follows a handled key even when the plugin forgot to notify', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 24, guest);
  expect(ui.backend.lastFrame).toContain('cursor at 0');
  await ui.press('down');
  await settle();
  expect(ui.backend.lastFrame).toContain('cursor at 1');
  await ui.press('down', 'down');
  await settle();
  expect(ui.backend.lastFrame).toContain('cursor at 3');
  ui.app.unmount();
});
