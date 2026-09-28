// A stopped turn's `stopped (Esc)` is its last row. Whatever the turn did after Esc — a
// call already running when it was pressed, finishing — is drawn above the label, and a
// write that landed says so there (✎), never under a line that says the turn ended.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import type { Make } from '../loader/plugin';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// A guest whose `edit_file` is held until the test lets it go and ignores the turn's
// signal, as a write already under way does: it finishes after Esc. With `view` it opens
// a block while it runs, as a command does.
function heldEditor(opts: { view?: boolean } = {}) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const guest = (make: Make) => [make('clone', {
    tools: [{
      id: 'clone',
      tools: [{ type: 'function', function: { name: 'edit_file', description: 'Edit a file.', parameters: { type: 'object', properties: { b: { type: 'number' } } } }, write: true }],
      exec: async (_n: string, _args: Record<string, unknown>, ctx: Record<string, unknown>) => {
        if (opts.view) (ctx as { liveView?: (k: string, d: unknown) => unknown }).liveView?.('console', { command: 'patch app.ts', output: 'patching…\n' });
        await gate;
        return 'edited';
      },
    }],
  } as never)] as never;
  return { guest, release: () => release() };
}

// The conversation's rows between the frame's top and the hint row, blank ones dropped.
const conversation = (frame: string) => {
  const rows = frame.split('\n').map((r) => r.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, ''));
  const top = rows.findIndex((r) => r.includes('› stop the edit'));
  const hint = rows.findIndex((r, i) => i > top && /history · wheel/.test(r));
  return rows.slice(top, hint).filter((r) => r.trim());
};

async function stoppedMidEdit(view: boolean, extra: Record<string, unknown> = {}) {
  const { guest, release } = heldEditor({ view });
  const model = new ScriptedModel();
  model.script([{ text: 'Next: change b.' }, { tool: 'edit_file', args: { b: 42 } }], [{ text: 'never sent' }]);
  const ui = await bootApp(model, 100, 30, guest, extra);
  await ui.press('F');
  await ui.type('stop the edit');
  await ui.press('return');
  await settle(20);
  expect(ui.backend.lastFrame).toContain('Confirm write: edit_file');
  await ui.press('y');
  await settle(10);
  await ui.press('escape'); // the edit is running: Esc stops the turn
  await settle(10);
  release(); // …and the edit finishes all the same
  await settle(30);
  return { ui, model };
}

test('a write that finishes after Esc is marked above `stopped (Esc)`, and nothing is drawn below it', async () => {
  const { ui, model } = await stoppedMidEdit(false);
  const rows = conversation(ui.backend.lastFrame);
  expect(rows.at(-1)).toMatch(/^\s*stopped \(Esc\)/);
  const step = rows.findIndex((r) => r.includes('▸ change b.'));
  expect(step).toBeGreaterThan(-1);
  expect(rows[step]).toContain('✎');
  expect(step).toBeLessThan(rows.length - 1);
  expect(model.requests).toHaveLength(1);
  ui.app.unmount();
});

test("a stopped call's block is drawn above `stopped (Esc)`, never under it", async () => {
  const { ui } = await stoppedMidEdit(true);
  const rows = conversation(ui.backend.lastFrame);
  const block = rows.findIndex((r) => r.includes('patch app.ts'));
  expect(block).toBeGreaterThan(-1);
  expect(rows.at(-1)).toMatch(/^\s*stopped \(Esc\)/);
  expect(block).toBeLessThan(rows.length - 1);
  ui.app.unmount();
});

test('the label stays the last row after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-stopped-'));
  const { ui } = await stoppedMidEdit(true, { sessions: { dir } });
  await new Promise((r) => setTimeout(r, 350)); // the debounced save
  ui.app.unmount();
  const again = await bootApp(new ScriptedModel(), 100, 30, undefined, { sessions: { dir } });
  await settle(6);
  await again.press('F');
  const rows = conversation(again.backend.lastFrame);
  expect(rows.findIndex((r) => r.includes('patch app.ts'))).toBeGreaterThan(-1);
  expect(rows.at(-1)).toMatch(/^\s*stopped \(Esc\)/);
  again.app.unmount();
});
