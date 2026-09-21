// The status line says what is happening NOW. A tool's label used to stay after the
// tool finished — the stream callbacks read a stale copy of it — so the chat looked
// stuck on the tool while the model was already writing its notes.
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const statusRow = (frame: string) => frame.split('\n').find((r) => /Esc stops/.test(r)) ?? '';

test('once the tool is done and the model writes, the line says "writing", not the tool', async () => {
  const model = new ScriptedModel();
  model.script(
    [{ tool: 'datetime', args: {} }],
    [{ text: 'Сейчас смотрю, ' }, { hold: true }, { text: 'готово.' }],
  );
  const ui = await bootApp(model, 110, 28);
  await ui.press('F');
  await ui.type('который час?');
  await ui.press('return');
  await settle(20);
  const row = statusRow(ui.backend.lastFrame);
  expect(row).toContain('1 tool call');
  expect(row).toContain('writing…');
  expect(row).not.toContain('⚙');
  model.release();
  await settle(20);
  ui.app.unmount();
});

test('a running tool is drawn bright, not dim — it moves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-toolstatus-'));
  const ui = await bootApp(new ScriptedModel(), 110, 28, undefined, { fs: { roots: [dir] } });
  await ui.press('F');
  await ui.type('!sleep 1');
  await ui.press('return');
  await settle(6);
  const rows = ui.backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes('$ sleep 1') && r.includes('Esc stops'));
  expect(y).toBeGreaterThanOrEqual(0);
  const style = ui.backend.lastBuffer.get(rows[y]!.indexOf('$ sleep 1'), y).style as { fg?: string; dim?: boolean };
  expect(style.dim).toBeFalsy();
  expect(style.fg).toBeTruthy();
  await ui.press('escape');
  await settle(6);
  ui.app.unmount();
});
