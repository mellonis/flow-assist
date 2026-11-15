// The recipe docs/plugins.md gives a plugin that shares the screen with the chat:
// `<Box inert={!host.hasKeyboard()}>` around the whole surface mutes every flowtyt
// component inside it in one move. The unit tests pin that the members are handed over
// (plugin-ui.test.ts); this one proves the muting itself, on the real app, because it is
// flowtyt's input layer and the host's key path that make it work, not the plugin.
import { expect, test } from 'bun:test';
import { ScriptedModel, bootApp } from './helpers/scripted';

const probe = (inert: boolean, presses: { count: number }) => (mk: any) => [mk('probe', {
  name: 'probe',
  components: {
    view: ({ ui }: any) => function View() {
      return ui.h(ui.Box, { flexDirection: 'column', inert },
        ui.h(ui.Text, null, inert ? 'DEAF' : 'AWAKE'),
        ui.h(ui.Button, { label: 'go', onPress: () => { presses.count += 1; } }));
    },
  },
})];

test('a Button in an awake surface takes its press', async () => {
  const presses = { count: 0 };
  const ui = await bootApp(new ScriptedModel(), 80, 24, probe(false, presses) as never);
  expect(ui.backend.lastFrame).toContain('AWAKE');
  expect(ui.backend.lastFrame).toContain('go');
  await ui.press('return');
  expect(presses.count).toBe(1);
  ui.app.unmount();
});

// The same Button, the same key, one wrapper: nothing is pressed. This is what a plugin
// that does not hold the keyboard owes the chat — and why it needs no per-control gate.
test('the same Button in an inert surface hears nothing', async () => {
  const presses = { count: 0 };
  const ui = await bootApp(new ScriptedModel(), 80, 24, probe(true, presses) as never);
  expect(ui.backend.lastFrame).toContain('DEAF');
  await ui.press('return');
  expect(presses.count).toBe(0);
  ui.app.unmount();
});

// Handed over is not the same as usable: the state components have to draw inside the
// plugin's own tree, off the app's render, not just be the right function. A spinner's
// frame is one of its set, a bar carries its percent — `drawn` says the tree reached the
// screen at all.
test('a plugin draws the running state flowtty ships: spinner, bar, tasks', async () => {
  const make = (mk: any) => [mk('probe', {
    name: 'probe',
    components: {
      view: ({ ui }: any) => function View() {
        return ui.h(ui.Box, { flexDirection: 'column' },
          ui.h(ui.Text, null, 'RUNNING'),
          ui.h(ui.Spinner, { label: 'thinking' }),
          ui.h(ui.ProgressBar, { value: 3, total: 4, width: 10, showPercent: true }),
          ui.h(ui.TaskList, { tasks: [{ label: 'read the tree', state: 'success' }, { label: 'write it', state: 'running' }] }));
      },
    },
  })];
  const ui = await bootApp(new ScriptedModel(), 80, 24, make as never);
  const frame = ui.backend.lastFrame;
  expect(frame).toContain('RUNNING');
  expect(frame).toContain('thinking');
  expect(frame).toContain('75%');
  expect(frame).toContain('read the tree');
  ui.app.unmount();
});
