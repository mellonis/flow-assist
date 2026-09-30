// A termination signal exits the way quitting does, with the app's renderer listening
// for the same signal: every session is saved and unlocked, and each task still running
// says in its session's journal that it stopped
// (AGENTS.md (a host makes its conversations through one registry)).
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJournal } from '../assistant/journal.ts';
import { listTree } from './helpers/session-files';

const HOST = path.join(import.meta.dir, 'helpers', 'signal-exit-host.ts');

test('SIGTERM with a background task running: exit 0, the task\'s task-end line by exit, no lock left', async () => {
  const ready = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-signal-ready-')), 'ready');
  const host = Bun.spawn(['bun', HOST, ready], { stdout: 'pipe', stderr: 'pipe' });
  try {
    // A loaded machine can take seconds to start bun and boot the app.
    for (let i = 0; i < 3000 && !fs.existsSync(ready) && host.exitCode === null; i++) await new Promise((r) => setTimeout(r, 10));
    if (!fs.existsSync(ready)) throw new Error(`the host never got ready: ${await new Response(host.stderr).text()}`);
    const dir = fs.readFileSync(ready, 'utf8');
    const locks = () => listTree(dir).filter((n) => n.endsWith('.lock'));
    expect(locks()).toHaveLength(1);
    host.kill('SIGTERM');
    const code = await host.exited;
    const stderr = await new Response(host.stderr).text();
    expect({ code, stderr }).toMatchObject({ code: 0 });
    const journals = listTree(dir).filter((n) => n.endsWith('.log.jsonl'));
    const ends = journals.flatMap((n) => readJournal(path.join(dir, n)) ?? []).filter((e) => e.t === 'task-end');
    expect(ends).toMatchObject([{ t: 'task-end', task: 'job', outcome: 'stopped', by: 'exit' }]);
    expect(locks()).toEqual([]);
  } finally {
    host.kill('SIGKILL');
  }
}, 60_000);
