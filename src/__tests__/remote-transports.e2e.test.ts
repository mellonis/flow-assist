// A remote plugin over real processes, through the App: a crash and its restart, two
// hosts on one shared server, and the host's own stop letting the child end cleanly
// (docs/plugins.md, "A plugin in another language").
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { transportFor } from '../remote/transports';
import { socketPath } from '../remote/sockets';
import { stdioTransport } from '../remote/transport-stdio';
import { supervise } from '../remote/supervisor';
import { stopRemotePlugins } from '../remote/lifecycle';
import type { TransportClose } from '../remote/transport';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const until = async (ok: () => boolean, label: string, n = 600) => {
  for (let i = 0; i < n && !ok(); i++) await settle(1);
  if (!ok()) throw new Error(`timed out waiting for ${label}`);
};
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const FAKE_DIR = path.resolve(import.meta.dir, 'helpers');
const RUN = ['bun', 'remote-fake-plugin.ts'];

test('a child that crashes says plugin stopped, and comes back after the backoff', async () => {
  const manifest = { name: 'fake', hostApi: 2, run: RUN };
  const log: string[] = [];
  const transport = transportFor(manifest, FAKE_DIR, { log: (l) => log.push(l) });
  process.env.FAKE_CRASH_ON_KEY = 'b';
  try {
    const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { chatMode: null, remote: { manifest, transport } });
    try {
      await until(() => ui.backend.lastFrame.includes('n=0'), 'the first frame');
      // The fake's frame consumes only 'b' (its own `bump` binding); that is also the
      // key that makes it exit(3) here, so a real key event reaches it before it dies.
      await ui.press('b');
      await until(() => ui.backend.lastFrame.includes('plugin stopped'), 'the stop note');
      expect(log.some((l) => l.includes('restarting in 1.0 s'))).toBe(true);
      await until(() => ui.backend.lastFrame.includes('n=0'), 'the restarted frame', 3_000);
    } finally {
      ui.app.unmount();
      await transport.close(3_000);
    }
  } finally {
    delete process.env.FAKE_CRASH_ON_KEY;
  }
});

test('two hosts share one server: one process, frames apart, state shared', async () => {
  const pidfile = `${socketPath('shared.sock')}.pid`;
  process.env.FAKE_PIDFILE = pidfile;
  const manifest = { name: 'fake', hostApi: 2, run: RUN, connect: 'unix:shared.sock' };
  const t1 = transportFor(manifest, FAKE_DIR, { log: () => {} });
  const t2 = transportFor(manifest, FAKE_DIR, { log: () => {} });
  try {
    const a = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { chatMode: null, remote: { manifest, transport: t1 } });
    try {
      const pid = fs.readFileSync(pidfile, 'utf8');
      const b = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { chatMode: null, remote: { manifest, transport: t2 } });
      try {
        expect(fs.readFileSync(pidfile, 'utf8')).toBe(pid);
        await until(() => a.backend.lastFrame.includes('client 1') && b.backend.lastFrame.includes('client 2'), 'both clients registered');
        await a.press('b');
        await until(() => a.backend.lastFrame.includes('n=1'), 'a bumped');
        // `a`'s own count (n) is its connection's alone; `shared` is the one server
        // process's, so it already carries `b`'s hello (2) before `a`'s own bump (3) —
        // the one process both hosts are on.
        await until(() => a.backend.lastFrame.includes('shared=3'), 'the shared count seen by a');
        // `b` hears nothing of `a`'s bump: each connection gets its own frames, and
        // there is no host.store-style broadcast in this fake.
        expect(b.backend.lastFrame).toContain('n=0');
      } finally {
        b.app.unmount();
      }
    } finally {
      a.app.unmount();
    }
  } finally {
    await t1.close(100);
    await t2.close(100);
    // The shared server outlives both transports (its idle timer is 60 s, the
    // adapter's DEFAULT_IDLE_MS — this test does not exercise its own exit, Task 4's
    // transport test drives idleMs directly): end it by hand so it never leaks into
    // another test's `pgrep`. Waited for, not just signalled — the next test's own
    // `pgrep`/socket check must not race this one's server on its way out.
    const serverPid = Number(fs.readFileSync(pidfile, 'utf8'));
    try { process.kill(serverPid, 'SIGTERM'); } catch { /* already gone */ }
    await until(() => !isAlive(serverPid), 'the shared server to exit');
    try { fs.unlinkSync(pidfile); } catch { /* already gone */ }
    delete process.env.FAKE_PIDFILE;
  }
});

test("the host's own stop lets the child exit cleanly, not by a signal", async () => {
  const manifest = { name: 'fake', hostApi: 2, run: RUN };
  const log: string[] = [];
  let closedWith: TransportClose | undefined;
  // `transportFor` itself hides the underlying stdio transport behind the supervisor,
  // which swallows a close it caused itself (`done` guard in supervisor.ts) — so the
  // raw transport is watched directly here, the only way to see what actually
  // happened to the child.
  const transport = supervise(
    () => {
      // Without this, stdin's own EOF (from `close`'s `stdin.end()`) would end a fake
      // that has nothing else keeping its event loop alive — passing with or without
      // the `shutdown` request ever being sent. The keepalive rules that out: only an
      // answered `shutdown` (the fake calls its own `process.exit(0)` once it is) or
      // the transport's SIGTERM/SIGKILL ends it.
      const t = stdioTransport({ name: 'fake', command: RUN, cwd: FAKE_DIR, env: { FAKE_KEEPALIVE: '1' }, log: (l) => log.push(l) });
      t.onClose((why) => { closedWith = why; });
      return t;
    },
    { name: 'fake', log: (l) => log.push(l) },
  );
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { chatMode: null, remote: { manifest, transport } });
  try {
    await until(() => ui.backend.lastFrame.includes('n=0'), 'the first frame');
    ui.app.unmount();
    await stopRemotePlugins();
    await until(() => closedWith !== undefined, 'the child to close');
    expect(closedWith).toEqual({ code: 0 });
  } finally {
    await transport.close(200);
  }
});
