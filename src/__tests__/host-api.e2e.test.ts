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
    setup: (f: any) => { seen.push(f.hostApi); },
  })];
  const ui = await bootApp(new ScriptedModel(), 80, 24, make as never);
  expect(seen).toEqual([HOST_API]);
  ui.app.unmount();
});
