// A test run keeps every temporary directory under one root and removes it at the end
// (helpers/tmp-root.ts). This checks the whole path: the child run is told to put its
// root in the wrapper, the fixture names the directory it made, and both the root and
// the fixture's own directory are gone by the time the child exits.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '../..');

test('a test run leaves no temporary directory behind', () => {
  const wrapper = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-hygiene-wrapper-'));
  const fixture = path.join(wrapper, 'hygiene.test.ts');
  const seen = path.join(wrapper, 'tmpdir.txt');
  fs.writeFileSync(fixture, [
    "import { test } from 'bun:test';",
    "import fs from 'node:fs';",
    "import os from 'node:os';",
    "import path from 'node:path';",
    "test('makes a temporary directory', () => {",
    "  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-hygiene-leaf-'));",
    "  fs.writeFileSync(" + JSON.stringify(seen) + ", `${os.tmpdir()}\\n${made}\\n`);",
    '});',
    '',
  ].join('\n'));

  try {
    const run = Bun.spawnSync({
      cmd: [process.execPath, 'test', fixture],
      cwd: repoRoot,
      env: { ...process.env, TMPDIR: wrapper, FLOW_ASSIST_TEST_TMP_BASE: wrapper },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(run.exitCode).toBe(0);
    const [runRoot, made] = fs.readFileSync(seen, 'utf8').trim().split('\n');
    expect(path.dirname(runRoot!)).toBe(wrapper);
    expect(path.dirname(made!)).toBe(runRoot!);
    expect(fs.existsSync(runRoot!)).toBe(false);
    expect(fs.existsSync(made!)).toBe(false);
    expect(fs.readdirSync(wrapper).filter((name) => name.startsWith('fa-'))).toEqual([]);
  } finally {
    fs.rmSync(wrapper, { recursive: true, force: true });
  }
});
