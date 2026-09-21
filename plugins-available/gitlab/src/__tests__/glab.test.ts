import { describe, it, expect } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGlab } from '../glab.ts';
import { buildGitlabGroup } from '../tools.ts';

// Real processes, not a mocked spawn: what is under test is how a process that
// fails, hangs or does not exist is turned into words for the model.
const fakeBin = (script: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'fa-glab-')), 'glab');
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  return file;
};

describe('the glab runner', () => {
  it('returns what glab printed, and passes argv through untouched', async () => {
    const bin = fakeBin('if [ "$1" = "--version" ]; then echo "glab 1.0"; exit 0; fi\nprintf \'{"argv":"%s"}\' "$*"');
    const glab = createGlab({ bin });
    expect(await glab.available()).toBe(true);
    expect(await glab.run(['api', '--method', 'GET', 'projects?x=$(id)'])).toBe('{"argv":"api --method GET projects?x=$(id)"}');
  });

  it('a failure is reported with glab\'s own words — never an empty success', async () => {
    const bin = fakeBin('echo \'{"message":"401 Unauthorized"}\'\necho "glab: 401 Unauthorized (HTTP 401)" >&2\nexit 1');
    const out = await createGlab({ bin }).run(['api', 'user']);
    expect(out).toContain('glab exited with 1');
    expect(out).toContain('HTTP 401');
    expect(out).toContain('401 Unauthorized');
    expect(out).not.toBe('{}');
  });

  it('a binary that is not there is said to be not there', async () => {
    const glab = createGlab({ bin: '/nonexistent/glab' });
    expect(await glab.available()).toBe(false);
    expect(await glab.run(['api', 'user'])).toMatch(/^glab failed:/);
  });

  it('a hung glab does not hang the turn', async () => {
    const bin = fakeBin('sleep 30');
    const started = Date.now();
    const out = await createGlab({ bin, timeoutMs: 300 }).run(['api', 'user']);
    expect(out).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('an empty body is named as such', async () => {
    expect(await createGlab({ bin: fakeBin('exit 0') }).run(['api', 'x'])).toBe('(glab returned an empty body)');
  });

  it('the tool group says glab is missing instead of calling it', async () => {
    const glab = createGlab({ bin: '/nonexistent/glab' });
    const group = buildGitlabGroup({ clip: (x: unknown) => x, glabAvailable: glab.available, runGlab: glab.run });
    await expect(group.exec('glab_api', { path: 'user' }, {})).rejects.toThrow(/glab is not installed/);
  });
});
