// What a fresh conversation keeps from the one it replaces: the field's ↑/↓ history; and
// what work outlived by /clear still reaches the fresh one: the settings-file guard's y/n.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptedConfigPath, guardConfigFiles, hostStateDir, loadConfig, resetSessionConfig, unguardConfigFiles } from '../config/load.ts';
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

const local = () => path.join(hostStateDir(), 'config.local.json');
const settleUntil = async (ok: () => boolean, n = 200) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

// A settings file changed by a command that /clear stops is asked about in the cleared
// chat as soon as the stopped work unwinds — not at the next turn.
for (const kind of ['the model\'s run_command', 'the person\'s !command']) {
  test(`a settings file changed by ${kind} stopped by /clear is asked about in the cleared chat`, async () => {
    try {
      fs.mkdirSync(hostStateDir(), { recursive: true });
      fs.rmSync(acceptedConfigPath(), { force: true });
      fs.writeFileSync(local(), '{}');
      loadConfig(); guardConfigFiles();
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-guard-root-')));
      const model = new ScriptedModel();
      const edit = `printf '%s' '{"shell":{"autoRun":true}}' > '${local()}'; echo WROTE; sleep 2`;
      model.script([{ tool: 'run_command', args: { command: edit } }], [{ text: 'Configured.' }]);
      const ui = await bootApp(model, 120, 34, undefined, { shell: { roots: [root], timeoutMs: 20000 } });
      await ui.press('F');
      if (kind.startsWith('the model')) {
        await ui.type('turn on auto run'); await ui.press('return');
        await settleUntil(() => ui.backend.lastFrame.includes('Confirm write'));
        await ui.press('y');
      } else {
        await ui.type('!' + edit); await ui.press('return');
      }
      await settleUntil(() => fs.readFileSync(local(), 'utf8').includes('autoRun'));
      await settle(20);
      const requests = model.requests.length;
      await ui.type('/clear'); await ui.press('return');
      await settleUntil(() => ui.backend.lastFrame.includes('changed outside flow-assist'), 300);
      expect(ui.backend.lastFrame).toContain('changed outside flow-assist');
      expect(model.requests.length).toBe(requests); // no further turn asked it
      ui.app.unmount();
    } finally {
      unguardConfigFiles(); resetSessionConfig();
      fs.rmSync(local(), { force: true }); fs.rmSync(acceptedConfigPath(), { force: true });
    }
  }, 20000);
}
