// flowtty's pickers reach a plugin through `ui`: `Select` is the dropdown, whose popup
// is a floating dialog the host's <DialogHost> opens; `ListSelect` / `ListMultiSelect`
// are the inline lists. docs/plugins.md says how a plugin gates them.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const ITEMS = [{ label: 'Frontend', value: 'fe' }, { label: 'Backend', value: 'be' }, { label: 'Design', value: 'ds' }];

// A guest whose surface draws one picker, focused while the plugin side has the keyboard.
function guest(which: 'Select' | 'ListSelect' | 'ListMultiSelect') {
  const chosen: unknown[] = [];
  const make = (mk: any) => [mk('boards', {
    name: 'boards',
    keycaps: () => ['c card'],
    components: {
      view: (api: any) => function View() {
        const [value, setValue] = api.ui.useState(which === 'ListMultiSelect' ? [] : undefined);
        const isFocused = api.host.hasKeyboard();
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

test('with the popup open, Ctrl+C takes a second press as everywhere else', async () => {
  const g = guest('Select');
  const ui = await bootApp(new ScriptedModel(), 100, 28, g.make as never);
  await ui.press('down');
  expect(ui.backend.lastFrame).toContain('Design');
  // The first press arms and is consumed — the backend's own exit does not run.
  expect(ui.backend.press({ name: 'c', ctrl: true })).toBe(true);
  await ui.press();
  expect(ui.exits()).toBe(0);
  expect(ui.backend.lastFrame).toContain('^c again to exit');
  // The second exits.
  expect(ui.backend.press({ name: 'c', ctrl: true })).toBe(true);
  expect(ui.exits()).toBe(1);
  ui.app.unmount();
});

// A surface that mounts after boot — the usual case: a board opened later — with a
// focused list. `o` opens it, → moves the focus from its dropdown to its list.
function lateGuest() {
  const state = { open: false, list: true, heard: [] as string[] };
  const make = (mk: any) => [mk('boards', {
    name: 'boards',
    keycaps: () => (state.open ? ['o board'] : []),
    components: {
      keys: (api: any) => function Keys() {
        api.host.useInputHandler({ mode: 'consume', priority: () => 10, handler: (key: { name: string }) => {
          if (key.name === 'o') { state.open = true; api.host.notify(); return true; }
          if (key.name === 'right') { state.list = !state.list; api.host.notify(); return true; }
          return false;
        } });
        return null;
      },
      view: (api: any) => function View() {
        // flowtty's own `useInput`: counts every delivery of a key.
        api.ui.useInput((key: { name: string }) => { state.heard.push(key.name); });
        const [one, setOne] = api.ui.useState('fe');
        const [pick, setPick] = api.ui.useState('fe');
        return api.ui.h(api.ui.Box, { flexDirection: 'column' },
          api.ui.h(api.ui.Text, null, 'BOARD'),
          api.ui.h(api.ui.Select, { items: ITEMS, value: one, onChange: setOne, isFocused: !state.list, width: 20 }),
          api.ui.h(api.ui.ListSelect, { items: ITEMS, value: pick, onChange: setPick, isFocused: state.list }));
      },
    },
  })];
  return { make, state };
}

test('a focused list in a surface mounted after boot takes F; the host does not open the chat', async () => {
  const g = lateGuest();
  const ui = await bootApp(new ScriptedModel(), 100, 28, g.make as never);
  await ui.press('o');
  expect(ui.backend.lastFrame).toContain('BOARD');
  await ui.type('F');
  expect(ui.backend.lastFrame).toContain('filter: F');
  expect(ui.backend.lastFrame).not.toContain('Flow Assist');
  ui.app.unmount();
});

test('after a dropdown opened and closed, the focused list still takes F before the host', async () => {
  const g = lateGuest();
  g.state.list = false;
  const ui = await bootApp(new ScriptedModel(), 100, 28, g.make as never);
  await ui.press('o');
  await ui.press('down');
  expect(ui.backend.lastFrame).toContain('▴'); // the popup is open
  await ui.press('escape');
  await ui.press('right');
  await ui.type('F');
  expect(ui.backend.lastFrame).toContain('filter: F');
  expect(ui.backend.lastFrame).not.toContain('Flow Assist');
  // And the host still hears what nothing on screen takes.
  await ui.press('right');
  await ui.type('F');
  expect(ui.backend.lastFrame).toContain('Flow Assist');
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
  ui.backend.press({ name: ']', ctrl: true });
  await ui.press();
  await ui.type('De');
  expect(ui.backend.lastFrame).toContain('Flow Assist');
  expect(ui.backend.lastFrame).toContain('› De');
  ui.app.unmount();
});

test('whatever the history of mounts and dropdowns, a key is delivered once; Ctrl+] waits for an open popup', async () => {
  const g = lateGuest();
  g.state.list = false;
  const ui = await bootApp(new ScriptedModel(), 100, 28, g.make as never);
  await ui.press('o');
  for (let i = 0; i < 3; i++) {
    await ui.press('down');
    expect(ui.backend.lastFrame).toContain('▴');
    await ui.press('escape');
    expect(ui.backend.lastFrame).not.toContain('▴');
  }
  // A key nobody on screen takes reaches a flowtty handler exactly once — the host's
  // second pass for it is heard by the host alone.
  g.state.heard.length = 0;
  await ui.press('f5');
  expect(g.state.heard).toEqual(['f5']);
  // With the popup open, Ctrl+] is not the host's.
  await ui.press('down');
  ui.backend.press({ name: ']', ctrl: true });
  await ui.press();
  expect(ui.backend.lastFrame).not.toContain('Flow Assist');
  await ui.press('escape');
  // Closed, it is.
  ui.backend.press({ name: ']', ctrl: true });
  await ui.press();
  expect(ui.backend.lastFrame).toContain('Flow Assist');
  ui.app.unmount();
});
