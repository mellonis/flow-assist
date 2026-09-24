// flowtty's pickers reach a plugin through `ft`: `Select` is the dropdown, whose popup
// is a floating dialog the host's <DialogHost> opens; `ListSelect` / `ListMultiSelect`
// are the inline lists (flowtty's old `Select` / `MultiSelect`, renamed in
// 1.0.0-alpha.24 with no aliases). docs/plugins.md says how a plugin gates them.
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
      view: (f: any) => function View() {
        const [value, setValue] = f.useState(which === 'ListMultiSelect' ? [] : undefined);
        const chat = f.store.chat as { open?: boolean; focus?: string } | undefined;
        const isFocused = !(chat?.open && chat.focus !== 'plugin');
        const onChange = (v: unknown) => { chosen.push(v); setValue(v); };
        return f.h(f.Box, { flexDirection: 'column' },
          f.h(f.Text, null, 'BOARD'),
          f.h(f[which], { items: ITEMS, value, onChange, isFocused, width: 20, placeholder: 'pick a board' }));
      },
    },
  })];
  return { make, chosen };
}

test('ft.Select is the dropdown: the host keeps the DialogHost its popup opens in', async () => {
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

test('ft.Select\'s popup closes on Esc with nothing changed', async () => {
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

test('ft.ListSelect and ft.ListMultiSelect are the inline lists', async () => {
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
