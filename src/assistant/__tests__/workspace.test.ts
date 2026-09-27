import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostStateDir } from '../../config/load.js';
import { projectHome } from '../sessions.js';
import { ensureWorkspace, resolveInWorkspace, workspaceDir, workspaceRoot, WORKSPACE_LEAF } from '../workspace.js';

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

test('the workspace root is projects/ under the host state, unless workspace.dir names another — resolved on every call', () => {
  expect(workspaceRoot({})).toBe(path.join(hostStateDir(), 'projects'));
  expect(workspaceRoot({ workspace: { dir: '/tmp/ws-root' } })).toBe('/tmp/ws-root');
  expect(workspaceRoot({ workspace: { dir: '~/ws' } })).toBe(path.join(os.homedir(), 'ws'));
});

test('a project\'s workspace sits under the sessions\' mirror of its path; no project is _global', () => {
  const root = '/state/projects';
  expect(workspaceDir(root, '/Users/me/app')).toBe(path.join(projectHome(root, '/Users/me/app'), WORKSPACE_LEAF));
  expect(workspaceDir(root, null)).toBe(path.join(root, '_global', WORKSPACE_LEAF));
});

test('a project nested inside another\'s path is never inside the outer project\'s workspace', () => {
  const root = '/state/projects';
  const outer = workspaceDir(root, '/Users/me/ws');
  const inner = workspaceDir(root, '/Users/me/ws/app');
  expect(inner.startsWith(outer + path.sep)).toBe(false);
  expect(outer.startsWith(inner + path.sep)).toBe(false);
});

test('ensureWorkspace makes the directories 0700, the leaf too when it already exists', () => {
  const root = tmp('fa-ws-');
  const dir = workspaceDir(root, '/p/app');
  ensureWorkspace(dir);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  fs.chmodSync(dir, 0o755);
  ensureWorkspace(dir);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
});

test('a path is confined to the workspace: no absolute path, no .., no link that leads out', () => {
  const root = tmp('fa-ws-');
  const dir = workspaceDir(root, null);
  ensureWorkspace(dir);
  const outside = tmp('fa-out-');
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'artifacts', 'out'));

  expect(resolveInWorkspace(dir, 'artifacts/plan.md')).toEqual({ abs: path.join(dir, 'artifacts', 'plan.md') });
  expect(resolveInWorkspace(dir, '')).toEqual({ abs: dir });
  for (const bad of ['/etc/passwd', '../x', 'artifacts/../../x', '~/x', 'artifacts/out/secret']) {
    const r = resolveInWorkspace(dir, bad);
    expect('error' in r).toBe(true);
    // Every refusal names the workspace, so the model knows where to write instead.
    expect((r as { error: string }).error).toContain(dir);
  }
});
