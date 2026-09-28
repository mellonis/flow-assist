// What a fresh conversation keeps from the one it replaces: the field's ↑/↓ history.
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

for (const cmd of ['/clear', '/new']) {
  test(`↑ after ${cmd} still offers what was typed before it`, async () => {
    const model = new ScriptedModel();
    model.script([{ text: 'Answered.' }]);
    const ui = await bootApp(model, 100, 28);
    await ui.press('F');
    await ui.type('an earlier question');
    await ui.press('return');
    await settle(20);
    await ui.type(cmd);
    await ui.press('return');
    await settle(10);
    expect(ui.backend.lastFrame).not.toContain('an earlier question');
    await ui.press('up'); // the command itself
    await ui.press('up');
    expect(ui.backend.lastFrame).toContain('an earlier question');
    ui.app.unmount();
  });
}
