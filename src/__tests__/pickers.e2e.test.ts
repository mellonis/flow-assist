// flowtty's pickers reach a plugin through `ui`: `Select` is the dropdown, whose popup
// is a floating dialog the host's <DialogHost> opens; `ListSelect` / `ListMultiSelect`
// are the inline lists. docs/plugins.md says how a plugin gates them.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const ITEMS = [{ label: 'Frontend', value: 'fe' }, { label: 'Backend', value: 'be' }, { label: 'Design', value: 'ds' }];

// A guest whose surface draws one picker, focused while the chat is not open.
function guest(which: 'Select' | 'ListSelect' | 'ListMultiSelect') {
  const chosen: unknown[] = [];
  const make = (mk: any) => [mk('boards', {
    name: 'boards',
    keycaps: () => ['c card'],
    components: {
      view: (api: any) => function View() {
        const [value, setValue] = api.ui.useState(which === 'ListMultiSelect' ? [] : undefined);
        const chat = api.host.store.chat as { open?: boolean; focus?: string } | undefined;
        const isFocused = !(chat?.open && chat.focus !== 'plugin');
        const onChange = (v: unknown) => { chosen.push(v); setValue(v); };
        return api.ui.h(api.ui.Box, { flexDirection: 'column' },
          api.ui.h(api.ui.Text, null, 'BOARD'),
          api.ui.h(api.ui[which], { items: ITEMS, value, onChange, isFocused, width: 20, placeholder: 'pick a board' }));
      },
    },
  })];
  return { make, chosen };
}

test('ui.Select is the dropdown: the host keeps the DialogHost its popup opens in', async () => {
  const g = guest('Select');
  const ui = await bootApp(new ScriptedModel(), 100, 28, g.make as never);
  expect(ui.backend.lastFrame).toContain('pick a board');
  // Closed, the options take no room.
  expect(ui.backend.lastFrame).not.toContain('Backend');
  await ui.press('down');
  // Open: the popup lists them.
  expect(ui.backend.lastFrame).toContain('Frontend');
  expect(ui.backend.lastFrame).toContain('Backend');
  expect(ui.backend.lastFrame).toContain('Design');
  await ui.press('down', 'return');
  expect(g.chosen.at(-1)).toBe('be');
  // Picked and closed: the field shows the choice, the popup is gone.
  expect(ui.backend.lastFrame).toContain('Backend');
  expect(ui.backend.lastFrame).not.toContain('Design');
  ui.app.unmount();
});

test('ui.Select\'s popup closes on Esc with nothing changed', async () => {
  const g = guest('Select');
  const ui = await bootApp(new ScriptedModel(), 100, 28, g.make as never);
  await ui.press('down');
  expect(ui.backend.lastFrame).toContain('Design');
  // While it is open every key is the popup's: `F` narrows the list, and the host's key
  // path — which would open the chat — is muted under the DialogHost.
  await ui.type('F');
  expect(ui.backend.lastFrame).toContain('Frontend');
  expect(ui.backend.lastFrame).not.toContain('Design');
  expect(ui.backend.lastFrame).not.toContain('Flow Assist');
  await ui.press('escape');
  expect(ui.backend.lastFrame).not.toContain('Design');
  expect(ui.backend.lastFrame).toContain('pick a board');
  expect(g.chosen).toEqual([]);
  ui.app.unmount();
});

test('ui.ListSelect and ui.ListMultiSelect are the inline lists', async () => {
  const one = guest('ListSelect');
  let ui = await bootApp(new ScriptedModel(), 100, 28, one.make as never);
  for (const l of ['Frontend', 'Backend', 'Design']) expect(ui.backend.lastFrame).toContain(l);
  await ui.press('down');
  expect(one.chosen.at(-1)).toBe('be');
  ui.app.unmount();

  const many = guest('ListMultiSelect');
  ui = await bootApp(new ScriptedModel(), 100, 28, many.make as never);
  for (const l of ['Frontend', 'Backend', 'Design']) expect(ui.backend.lastFrame).toContain(l);
  await ui.press(' ');
  expect(many.chosen.at(-1)).toEqual(['fe']);
  ui.app.unmount();
});

test('with the popup open, Ctrl+C is not taken: the backend exits at once', async () => {
  const g = guest('Select');
  const ui = await bootApp(new ScriptedModel(), 100, 28, g.make as never);
  await ui.press('down');
  expect(ui.backend.lastFrame).toContain('Design');
  // Not consumed — by the popup, or by the host's arm under the DialogHost — so the
  // TTY backend's own default, exit, runs.
  expect(ui.backend.press({ name: 'c', ctrl: true })).toBe(false);
  ui.app.unmount();
});

test('a focused ListSelect takes what is typed as its filter; Ctrl+] still reaches the host', async () => {
  const g = guest('ListSelect');
  const ui = await bootApp(new ScriptedModel(), 100, 28, g.make as never);
  // `F` would open the chat; the focused list takes it for its filter.
  await ui.type('F');
  expect(ui.backend.lastFrame).not.toContain('Flow Assist');
  expect(ui.backend.lastFrame).toContain('Frontend');
  expect(ui.backend.lastFrame).not.toContain('Design');
  // The host's chord is not the list's: the chat opens, and the list, no longer
  // focused, leaves what is typed to it.
  await ui.press('\x1d');
  await ui.type('De');
  expect(ui.backend.lastFrame).toContain('Flow Assist');
  expect(ui.backend.lastFrame).toContain('› De');
  ui.app.unmount();
});
