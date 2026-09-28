// A host that loads one remote plugin the way the interactive app does (late: the
// handshake goes on in the background) and exits while that handshake is still
// pending, the way the app's own exit does — `stopRemotePlugins`, then `process.exit`.
// The plugin is the fake process with `FAKE_NO_HELLO`: it never answers `hello`.
// argv: <pidfile the plugin writes>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlugins } from '../../loader/build';
import { createLatePlugins } from '../../loader/late';
import { stopRemotePlugins } from '../../remote/lifecycle';

const pidfile = process.argv[2]!;
process.env.FAKE_NO_HELLO = '1';
process.env.FAKE_PIDFILE = pidfile;
const enabled = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-late-exit-'));
const helpers = path.resolve(import.meta.dir);
fs.mkdirSync(path.join(enabled, 'fake'));
// `run` resolves against the plugin's own directory: a path back to the fake.
fs.writeFileSync(path.join(enabled, 'fake', 'manifest.json'), JSON.stringify({ name: 'fake', hostApi: 2, run: ['bun', path.join(helpers, 'remote-fake-plugin.ts')] }));
const late = createLatePlugins();
const repo = { enabledPlugins: async () => ['fake'], list: async () => [] } as never;
await loadPlugins({ config: {}, repo, enabledDir: enabled, late });
for (let i = 0; i < 200 && !fs.existsSync(pidfile); i++) await new Promise((r) => setTimeout(r, 10));
if (late.starting().join() !== 'fake') { console.error(`expected fake to be starting, got ${late.starting().join()}`); process.exit(2); }
await stopRemotePlugins();
process.exit(0);
