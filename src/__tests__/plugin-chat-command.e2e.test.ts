// A plugin's command in the chat: declared once with `chat: true`, it is the chat's
// `/name` as well as the `:` line's, completes every word it declares, says what it has to
// say as a note, and opens a panel in the conversation's place with keys of its own. The
// host's services beside it: a note from outside a command (`chatNote`, held while a turn
// runs), and a config write that goes the `config set` path (`setConfig`).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { hostStateDir } from '../config/load';
import type { Make } from '../loader/plugin';
import { z } from 'zod';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Ui = Awaited<ReturnType<typeof bootApp>>;
const frame = (ui: Ui) => ui.backend.lastFrame;

function guest(state: { ran: string[]; host?: { services: Record<string, any> } }) {
  const servers = [{ id: 'webstorm', state: 'connected · 23 tools' }, { id: 'safari', state: 'failed — HTTP 502' }];
  return (make: Make) => [make('srv', {
    name: 'srv',
    configSchema: z.object({ flag: z.boolean().optional(), other: z.string().optional() }).optional(),
    setup: ({ host }: { host: { services: Record<string, any> } }) => { state.host = host; },
    commands: [{
      name: 'srv', usage: 'srv [restart <name>]', description: 'The servers', chat: true,
      complete: (words: string[]) => (words.length === 0 ? ['restart', 'list'] : words.length === 1 ? servers.map((s) => s.id) : []),
      run: (ctx: any, arg = '') => {
        const [sub, name] = arg.split(/\s+/);
        state.ran.push(`${ctx.surface}:${arg}`);
        if (sub === 'restart') { ctx.say(`restarting ${name}`); return; }
        if (sub === 'list' || ctx.surface !== 'chat') { (ctx.say ?? ctx.showMessage)(servers.map((s) => `${s.id} ${s.state}`).join(' · ')); return; }
        ctx.openPanel({
          title: 'Servers',
          rows: () => servers.map((s) => ({ id: s.id, text: s.id, detail: s.state, tone: s.state.startsWith('failed') ? 'error' : 'ok' })),
          keys: [
            { key: 'r', label: 'restart', run: (id: string) => { state.ran.push(`panel-r:${id}`); return `restarting ${id}`; } },
            { key: 't', label: 'tools', run: (id: string) => ({ title: `Tools of ${id}`, rows: () => [{ id: 'get_file_text', text: 'get_file_text', detail: 'read-only' }] }) },
          ],
        });
      },
    }],
  } as never)];
}

test('/name runs a plugin command marked for the chat; its later words complete; a note says what it said', async () => {
  const state = { ran: [] as string[] };
  const ui = await bootApp(new ScriptedModel(), 110, 30, guest(state));
  await ui.press('F');
  await ui.type('/sr');
  expect(frame(ui)).toContain('/srv'); // offered by name
  await ui.press('tab');
  await ui.type(' restart sa');
  expect(frame(ui)).toContain('restart safari');
  await ui.press('tab');
  await ui.press('return');
  expect(state.ran).toEqual(['chat:restart safari']);
  expect(frame(ui)).toContain('restarting safari');
  ui.app.unmount();
  // An unknown command names the plugin's among the ones there are.
  const wide = await bootApp(new ScriptedModel(), 260, 30, guest({ ran: [] }));
  await wide.press('F');
  await wide.type('/nope');
  await wide.press('return');
  expect(frame(wide)).toMatch(/unknown command \/nope — available: .*\/exit, \/srv/);
  wide.app.unmount();
});

test('a command\'s panel stands in the conversation\'s place: rows, a cursor, the plugin\'s keys, a panel over it, Esc back', async () => {
  const state = { ran: [] as string[] };
  const ui = await bootApp(new ScriptedModel(), 110, 30, guest(state));
  await ui.press('F');
  await ui.type('/srv');
  await ui.press('return');
  expect(frame(ui)).toContain('Servers');
  expect(frame(ui)).toContain('webstorm');
  expect(frame(ui)).toContain('failed — HTTP 502');
  expect(frame(ui)).toMatch(/r restart · t tools/);
  // The field is not drawn: the panel holds the keys.
  await ui.press('down');
  await ui.type('r');
  expect(state.ran).toContain('panel-r:safari');
  expect(frame(ui)).toContain('restarting safari');
  await ui.type('t');
  expect(frame(ui)).toContain('Tools of safari');
  expect(frame(ui)).toContain('get_file_text');
  await ui.press('escape');
  expect(frame(ui)).toContain('Servers');
  await ui.press('escape');
  expect(frame(ui)).not.toContain('Tools of safari');
  expect(frame(ui)).not.toContain('r restart');
  // The field is back and empty.
  await ui.type('hello');
  expect(frame(ui)).toContain('hello');
  ui.app.unmount();
});

test(':name on the command line runs the same command, with no chat around it', async () => {
  const state = { ran: [] as string[] };
  const ui = await bootApp(new ScriptedModel(), 110, 30, guest(state));
  await ui.type(':srv');
  await ui.press('return');
  expect(state.ran).toEqual(['line:']);
  expect(frame(ui)).toContain('webstorm connected · 23 tools · safari failed');
  ui.app.unmount();
});

test('chatNote says a plugin\'s news in the chat — after the turn, when one runs', async () => {
  const state = { ran: [] as string[] } as { ran: string[]; host?: { services: Record<string, any> } };
  const model = new ScriptedModel();
  model.script([{ hold: true }, { text: 'Done.' }]);
  const ui = await bootApp(model, 110, 30, guest(state));
  await ui.press('F');
  state.host!.services.chatNote('srv: safari connected — 17 tools');
  await settle();
  expect(frame(ui)).toContain('safari connected — 17 tools');
  await ui.type('hi');
  await ui.press('return');
  state.host!.services.chatNote('srv: webstorm connected — 23 tools');
  await settle();
  // Held: a note in the middle would split the turn's message.
  expect(frame(ui)).not.toContain('webstorm connected');
  model.release();
  await settle(20);
  expect(frame(ui)).toContain('Done.');
  expect(frame(ui)).toContain('webstorm connected — 23 tools');
  ui.app.unmount();
});

test('setConfig writes a plugin\'s key the way config set does — saved, or for this run only', async () => {
  const state = { ran: [] as string[] } as { ran: string[]; host?: { services: Record<string, any> } };
  const ui = await bootApp(new ScriptedModel(), 110, 30, guest(state), {});
  const svc = state.host!.services;
  // Checked against the plugin's own schema, as `config set` checks it.
  expect(svc.setConfig('plugins.srv.flag', 'yes').ok).toBe(false);
  const saved = svc.setConfig('plugins.srv.flag', true);
  expect(saved).toMatchObject({ ok: true, value: true });
  const local = JSON.parse(fs.readFileSync(path.join(hostStateDir(), 'config.local.json'), 'utf8'));
  expect(local.plugins.srv.flag).toBe(true);
  const session = svc.setConfig('plugins.srv.other', 'x', { session: true });
  expect(session.ok).toBe(true);
  const again = JSON.parse(fs.readFileSync(path.join(hostStateDir(), 'config.local.json'), 'utf8'));
  expect(again.plugins.srv.other).toBeUndefined();
  expect(svc.unsetConfig('plugins.srv.flag').ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(hostStateDir(), 'config.local.json'), 'utf8')).plugins?.srv?.flag).toBeUndefined();
  ui.app.unmount();
});
