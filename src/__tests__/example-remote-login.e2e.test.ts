import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { transportFor } from '../remote/transports';
import { socketPath } from '../remote/sockets';
import manifest from '../../examples/remote-login/manifest.json';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const until = async (ok: () => boolean, label: string, n = 300) => {
  for (let i = 0; i < n && !ok(); i++) await settle(1);
  if (!ok()) throw new Error(`timed out waiting for ${label}`);
};

test('the login example runs as a real process: its form draws, typing reaches it, and it signs in', async () => {
  const dir = path.resolve(import.meta.dir, '../../examples/remote-login');
  const transport = transportFor(manifest, dir, { log: () => {} });
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { chatMode: null, remote: { manifest, transport } });
  try {
    await until(() => ui.backend.lastFrame.includes('remote-login'), 'the plugin on the start screen');
    await ui.press('S');
    await until(() => ui.backend.lastFrame.includes('Sign in'), 'the form');
    // Every cap is an action's, drawn with the key it is bound to.
    const footer = ui.backend.lastFrame.split('\n').find((r) => r.includes(': commands')) ?? '';
    expect(footer).toContain('S form');
    expect(footer).toContain('⏎ log in');
    await ui.type('ann');
    await ui.press('tab');
    await ui.type('secret');
    await ui.press('tab');
    await ui.press('return');
    await until(() => ui.backend.lastFrame.includes('signed in as ann'), 'the signed-in note');
    expect(ui.backend.lastFrame).toContain('Signed in'); // the toast
    expect(ui.backend.lastFrame).not.toContain('secret'); // masked
  } finally {
    ui.app.unmount();
    await transport.close(500);
  }
});

test('the example follows a remap: its own actions are consumed on the keys the person bound them to', async () => {
  const dir = path.resolve(import.meta.dir, '../../examples/remote-login');
  const transport = transportFor(manifest, dir, { log: () => {} });
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, { keys: { open: 'O', next: 'ctrl+n' } }, { chatMode: null, remote: { manifest, transport } });
  try {
    await until(() => ui.backend.lastFrame.includes('remote-login'), 'the plugin on the start screen');
    await ui.press('S'); // the default no longer opens it
    await settle(20);
    expect(ui.backend.lastFrame).not.toContain('Sign in');
    await ui.press('O');
    await until(() => ui.backend.lastFrame.includes('Sign in'), 'the form');
    const footer = ui.backend.lastFrame.split('\n').find((r) => r.includes(': commands')) ?? '';
    expect(footer).toContain('O form');
    expect(footer).toContain('^n next');
    await ui.type('ann');
    ui.backend.press({ name: 'n', ctrl: true });
    await settle(20);
    await ui.type('pw'); // into the password field: ^n moved the focus
    await settle(20);
    expect(ui.backend.lastFrame).toContain('ann');
    expect(ui.backend.lastFrame).not.toContain('annpw');
    expect(ui.backend.lastFrame).not.toContain('pw');
  } finally {
    ui.app.unmount();
    await transport.close(500);
  }
});

test('the plugin process exits once its stdin closes, as it does when the host that spawned it dies', async () => {
  const dir = path.resolve(import.meta.dir, '../../examples/remote-login');
  const proc = Bun.spawn(['bun', 'src/index.ts'], { cwd: dir, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
  try {
    await proc.stdin.end();
    const code = await Promise.race([
      proc.exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000)),
    ]);
    expect(code).toBe(0);
  } finally {
    if (proc.exitCode === null) proc.kill();
  }
});

test('the example is also a shared server: started with --serve on a socket, it signs in the same way', async () => {
  const dir = path.resolve(import.meta.dir, '../../examples/remote-login');
  const shared = { ...manifest, connect: 'unix:login.sock' };
  const sock = socketPath('login.sock');
  const log: string[] = [];
  const transport = transportFor(shared, dir, { log: (l) => log.push(l) });
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let pid = 0;
  try {
    const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { chatMode: null, remote: { manifest: shared, transport } });
    try {
      // The example writes no pid file of its own: the server is the process the
      // transport says it started.
      pid = Number(/--serve \(pid (\d+)\)/.exec(log.find((l) => l.includes('--serve (pid')) ?? '')?.[1] ?? 0);
      expect(pid).toBeGreaterThan(0);
      expect(alive(pid)).toBe(true);
      await until(() => ui.backend.lastFrame.includes('remote-login'), 'the plugin on the start screen');
      await ui.press('S');
      await until(() => ui.backend.lastFrame.includes('Sign in'), 'the form');
      await ui.type('ann');
      await ui.press('tab');
      await ui.type('secret');
      await ui.press('tab');
      await ui.press('return');
      await until(() => ui.backend.lastFrame.includes('signed in as ann'), 'the signed-in note');
    } finally {
      ui.app.unmount();
      await transport.close(500);
    }
    expect(alive(pid)).toBe(true); // a host only disconnects from a shared server
  } finally {
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      await until(() => !alive(pid), 'the server to exit');
    }
    for (const f of [sock, `${sock}.lock`, `${sock}.log`]) fs.rmSync(f, { force: true });
  }
});
