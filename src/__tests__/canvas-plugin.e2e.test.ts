// src/__tests__/canvas-plugin.e2e.test.ts
import { expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import buildCanvasPlugin from '../../plugins-available/canvas/src/index.ts';

const boot = (model: ScriptedModel) => bootApp(model, 110, 32, (make) => [buildCanvasPlugin({ make, config: {} })]);

test('the model draws a canvas with a read tool; the answer names it and the context carries it', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'canvas_draw', args: { canvas: 'ci', title: 'Pipelines', owner: 'reviewer', tree: ['Box', {}, ['badge', { text: 'failed', tone: 'error' }]] } }],
    [{ text: 'Drawn.' }],
  );
  const ui = await boot(model);
  await ui.press('F');
  await ui.type('show me the pipeline');
  await ui.press('return');
  await settle(20);
  const last = model.requests.at(-1)!.messages as Array<{ role: string; content?: unknown }>;
  const toolMsgs = last.filter((m) => m.role === 'tool');
  expect(String(toolMsgs.at(-1)?.content)).toContain('«ci»');
  // no y/n: it is a read
  expect(ui.backend.lastFrame).not.toContain('Confirm write: canvas_draw');
  // the next request carries what the person sees
  const tail = String((model.requests.at(-1) as { messages: Array<{ role: string; content?: unknown }> }).messages.at(-1)?.content ?? '');
  expect(tail).toContain('Pipelines');
  // The selected canvas's outline travels with the context, and a badge's text is only
  // in the outline — so this also says the draw carried `askUser` and took the selection.
  expect(tail).toContain('badge failed');
});
