// A plugin whose manifest names several host APIs learns at run time which one it is
// running under.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp } from './helpers/scripted';
import { HOST_API } from '../version';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('a plugin reads the host API it runs under', async () => {
  const seen: unknown[] = [];
  const make = (mk: any) => [mk('probe', {
    name: 'probe',
    setup: (api: any) => { seen.push(api.host.hostApi); },
  })];
  const ui = await bootApp(new ScriptedModel(), 80, 24, make as never);
  expect(seen).toEqual([HOST_API]);
  ui.app.unmount();
});

// A plugin is given `{ ui, host }`: React and flowtty from `ui`, the host's services from
// `host` — here a list drawn with `ui.ListSelect` whose Enter says what was picked
// through `host.services.showMessage`.
test('a plugin draws with ui and speaks through host', async () => {
  const items = [{ label: 'Frontend', value: 'fe' }, { label: 'Backend', value: 'be' }];
  const make = (mk: any) => [mk('boards', {
    name: 'boards',
    keycaps: ({ host }: any) => [`${host.keyCap('openLog') || 'L'} log`],
    components: {
      view: ({ ui, host }: any) => function View() {
        const [value, setValue] = ui.useState('fe');
        return ui.h(ui.Box, { flexDirection: 'column' },
          ui.h(ui.Text, null, 'BOARDS'),
          ui.h(ui.ListSelect, { items, value, onChange: setValue, isFocused: true,
            onSubmit: () => (host.services.showMessage as (m: string) => void)(`picked ${value}`) }));
      },
    },
  })];
  const ui = await bootApp(new ScriptedModel(), 80, 24, make as never);
  expect(ui.backend.lastFrame).toContain('BOARDS');
  expect(ui.backend.lastFrame).toContain('Backend');
  await ui.press('down');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('picked be');
  ui.app.unmount();
});

// `host.hasKeyboard()` is what a plugin gates the flowtty components that hear keys
// themselves with: false while anything of the host's has the keyboard.
test('host.hasKeyboard() says whether the plugin side has the keyboard', async () => {
  // What the view read on its last draw — a modal may cover the text.
  let last = '';
  const make = (mk: any) => [mk('boards', {
    name: 'boards',
    keycaps: () => ['c board'],
    components: {
      view: ({ ui, host }: any) => function View() {
        last = host.hasKeyboard() ? 'yes' : 'no';
        return ui.h(ui.Text, null, `keys: ${last}`);
      },
    },
  })];
  const ui = await bootApp(new ScriptedModel(), 100, 28, make as never);
  const keys = () => last;
  expect(keys()).toBe('yes');
  await ui.press(':');
  expect(keys()).toBe('no');
  await ui.press('escape');
  expect(keys()).toBe('yes');
  await ui.press('L');
  expect(keys()).toBe('no');
  await ui.press('L');
  expect(keys()).toBe('yes');
  await ui.press(':');
  await ui.type('help');
  await ui.press('return');
  expect(ui.backend.lastFrame).toContain('commands');
  expect(keys()).toBe('no');
  await ui.press('escape');
  expect(keys()).toBe('yes');
  await ui.press('F');
  expect(ui.backend.lastFrame).toContain('Flow Assist');
  expect(keys()).toBe('no');
  ui.app.unmount();
});
