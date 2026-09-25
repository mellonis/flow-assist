import { afterEach, expect, test } from 'bun:test';
import path from 'node:path';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import type { RestartingTransport } from '../remote/transport';
import manifest from '../../examples/remote-login/manifest.json';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const until = async (ok: () => boolean, n = 300) => { for (let i = 0; i < n && !ok(); i++) await settle(1); };

function spawnTransport(cmd: string[], cwd: string): RestartingTransport {
  const lines: Array<(l: string) => void> = []; const closes: Array<(w: { code?: number }) => void> = [];
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  return {
    send: (l) => { proc?.stdin.write(`${l}\n`); },
    onLine: (f) => { lines.push(f); },
    onClose: (f) => { closes.push(f); },
    onRestart: () => {},
    async start() {
      proc = Bun.spawn(cmd, { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
      (async () => {
        let buf = '';
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          buf += new TextDecoder().decode(chunk);
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); lines.forEach((f) => f(line)); }
        }
      })();
      proc.exited.then((code) => closes.forEach((f) => f({ code })));
    },
    async close() { proc?.kill(); },
  };
}

test('the login example runs as a real process: its form draws, typing reaches it, and it signs in', async () => {
  const dir = path.resolve(import.meta.dir, '../../examples/remote-login');
  const transport = spawnTransport(['bun', 'src/index.ts'], dir);
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { chatMode: null, remote: { manifest, transport } });
  await until(() => ui.backend.lastFrame.includes('remote-login'));
  await ui.press('S');
  await until(() => ui.backend.lastFrame.includes('Sign in'));
  await ui.type('ann');
  await ui.press('tab');
  await ui.type('secret');
  await ui.press('tab');
  await ui.press('return');
  await until(() => ui.backend.lastFrame.includes('signed in as ann'));
  expect(ui.backend.lastFrame).toContain('Signed in'); // the toast
  expect(ui.backend.lastFrame).not.toContain('secret'); // masked
  ui.app.unmount();
  await transport.close(500);
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
