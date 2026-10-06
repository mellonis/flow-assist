// A run_command the model started and a key stopped says which key, in the journal's
// result and in the console row the chat shows (AGENTS.md (a host makes its conversations
// through one registry)).
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedModel } from './helpers/scripted';
import { closeRigs, conversationRig } from './helpers/conversation';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; closeRigs(); });

const readPid = (file: string): number | null => {
  try { const n = Number(fs.readFileSync(file, 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; }
};
const killGroup = (pid: number) => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } };

// A turn holds a run_command; `stop` ends it, and the turn's journal and console row are read.
async function stoppedBy(stop: (rig: ReturnType<typeof conversationRig>) => void) {
  const model = new ScriptedModel();
  const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-stopkey-'));
  const pidPath = path.join(pidDir, 'pid');
  model.script([{ tool: 'run_command', args: { command: `echo $$ > '${pidPath}'; sleep 30` } }], [{ text: 'never' }]);
  const rig = conversationRig(model, { shell: { autoRun: true }, policy: { kind: 'allow-writes', say: () => {} } });
  const c = rig.conv;
  let pid: number | null = null;
  try {
    const turn = c.send('run it');
    await rig.until(() => readPid(pidPath) !== null);
    pid = readPid(pidPath);
    stop(rig);
    await turn;
    const call = rig.journal(c.sessionId).find((e) => e.t === 'call' && (e as { name?: string }).name === 'run_command') as { result?: string } | undefined;
    const view = c.rows().find((r) => r.role === 'view') as { views?: { data?: { status?: string } }[] } | undefined;
    return { result: String(call?.result ?? ''), status: view?.views?.[0]?.data?.status };
  } finally {
    if (pid) killGroup(pid);
    fs.rmSync(pidDir, { recursive: true, force: true });
  }
}

test('a command stopped with ^c says ^c, in the journal and in its console row', async () => {
  const r = await stoppedBy((rig) => { rig.conv.stop('^c'); });
  expect(r.result).toContain('stopped (^c)');
  expect(r.result).not.toContain('stopped (Esc)');
  expect(r.status).toBe('stopped (^c)');
});

test('a command stopped by the process exiting says exit', async () => {
  const r = await stoppedBy((rig) => { rig.registry.closeAll('exit'); });
  expect(r.result).toContain('stopped (exit)');
});

test('a command stopped with no key says Esc', async () => {
  const r = await stoppedBy((rig) => { rig.conv.stop(''); });
  expect(r.result).toContain('stopped (Esc)');
});
