// `/copy` through the real chat. The clipboard write is replaced — a test run must not
// overwrite the person's clipboard; everything before it is the real module. Bun's
// mock.module is process-wide, so a call that brings its own `exec` (the unit tests
// of copy.ts) still reaches the real function.
import { afterEach, expect, mock, test } from 'bun:test';

const copied: string[] = [];
const real = await import('../assistant/copy.ts');
// Taken BEFORE the mock: `real` is a live namespace, so after mock.module its
// copyToClipboard IS the mock — calling it from the mock never returns.
const { copyTarget, copyToClipboard: realCopy } = real;
mock.module('../assistant/copy.ts', () => ({
  copyTarget,
  copyToClipboard: (text: string, platform?: string, exec?: Parameters<typeof realCopy>[2]) => {
    if (exec) return realCopy(text, platform, exec);
    copied.push(text);
    return { ok: true };
  },
}));
const { ScriptedModel, bootApp, settle } = await import('./helpers/scripted');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('/copy puts the last code block on the clipboard and says so; nothing goes to the model', async () => {
  const model = new ScriptedModel();
  model.script([{ text: 'Проверить локально:\n\n```sh\nbun test src/features/routes\n```\n' }]);
  const ui = await bootApp(model, 100, 28);
  await ui.press('F');
  await ui.type('как проверить локально?');
  await ui.press('return');
  await settle(20);

  await ui.type('/copy');
  await ui.press('return');
  await settle(4);
  expect(copied).toEqual(['bun test src/features/routes']);
  expect(ui.backend.lastFrame).toContain('Copied the sh code block');
  expect(model.requests).toHaveLength(1);
  ui.app.unmount();
});
