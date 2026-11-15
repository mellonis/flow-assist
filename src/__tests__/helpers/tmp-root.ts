// A test run keeps every temporary directory it makes under one root, and removes the
// root when the run ends: the chosen base gains one entry, not one per test. This is
// the first preload (bunfig.toml), before any module that reads the environment at load
// time (src/config/load.ts, src/loader/trust.ts, src/assistant/memory-trust.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'bun:test';

// A harness may name the base explicitly (the hygiene test does): it is honoured as is.
// Otherwise a long per-user temp dir (`/var/folders/...` on macOS) is replaced by `/tmp`
// where it is writable: some frames assert a whole line of text, and the longer path
// pushes the line past the frame's width. `os.tmpdir()` stays the default everywhere else.
const override = process.env.FLOW_ASSIST_TEST_TMP_BASE;
const system = os.tmpdir();
const short = '/tmp';
const writable = (candidate: string) => {
  try {
    fs.accessSync(candidate, fs.constants.W_OK);
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};
const base = override ?? (system.length > 32 && writable(short) ? short : system);
const root = fs.mkdtempSync(path.join(base, 'fa-'));
process.env.TMPDIR = root;

const remove = () => fs.rmSync(root, { recursive: true, force: true });
afterAll(remove);
process.once('exit', remove);
