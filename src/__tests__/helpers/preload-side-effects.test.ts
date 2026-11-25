// The preload's side effects must not travel with a module tests import. `helpers/scripted.ts`
// is also reachable from a plain `bun` process — signal-exit's host boots the real app that
// way — and it imports the harness for the pristine fetch. `bun:test` hooks registered on
// that path have no runner to attach to, and a catch broad enough to hide that hides any
// other failure of the registration too. Every side effect therefore lives in a module only
// the preload loads; this test pins the other half: the importable module leaves the process
// as it found it. The retry no-op is the visible one — a host started this way must still
// wait between a failed request's repeats.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dir;

test('a plain bun script that imports the test helpers keeps the real retry sleep', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-preload-'));
  const script = path.join(dir, 'probe.ts');
  const url = (p: string) => JSON.stringify(pathToFileURL(p).href);
  fs.writeFileSync(script, [
    `import ${url(path.join(here, 'scripted.ts'))};`,
    `import { retryClock } from ${url(path.join(here, '../../assistant/llm-retry.ts'))};`,
    'const t0 = performance.now();',
    'await retryClock.sleep(20);',
    'console.log(String(Math.round(performance.now() - t0)));',
  ].join('\n'));
  try {
    const p = Bun.spawn(['bun', script], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
    const code = await p.exited;
    const out = (await new Response(p.stdout).text()).trim();
    const err = await new Response(p.stderr).text();
    expect(code, `exit ${code}; stderr: ${err}`).toBe(0);
    // Load only lengthens this: a no-op sleep is the failure being looked for.
    expect(Number(out), `slept ${out} ms`).toBeGreaterThanOrEqual(15);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
