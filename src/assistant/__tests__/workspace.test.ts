import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostStateDir } from '../../config/load.js';
import { projectHome } from '../sessions.js';
import { ensureWorkspace, listWorkspace, readWorkspaceFile, resolveInWorkspace, workspaceDir, workspaceRoot, writeArtifact, WORKSPACE_LEAF } from '../workspace.js';

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

const fresh = () => {
  const dir = workspaceDir(tmp('fa-ws-'), '/p/app');
  ensureWorkspace(dir);
  return dir;
};

test('a working file is written under artifacts/, 0600, whole — and says what was there before', () => {
  const dir = fresh();
  const first = writeArtifact(dir, 'artifacts/notes/plan.md', 'one\n');
  expect(first).toEqual({ abs: path.join(dir, 'artifacts', 'notes', 'plan.md'), before: null });
  expect(fs.readFileSync(first.abs, 'utf8')).toBe('one\n');
  expect(fs.statSync(first.abs).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.join(dir, 'artifacts', 'notes')).mode & 0o777).toBe(0o700);
  expect(writeArtifact(dir, 'artifacts/notes/plan.md', 'two\n').before).toBe('one\n');
});

test('a write that would leave artifacts/ is refused by throwing, naming the path to use', () => {
  const dir = fresh();
  const outside = tmp('fa-out-');
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'artifacts', 'out'));
  fs.symlinkSync(path.join(outside, 'x.md'), path.join(dir, 'artifacts', 'link.md'));
  const refused = (rel: string) => { try { writeArtifact(dir, rel, 'x'); return ''; } catch (e) { return (e as Error).message; } };
  expect(refused('/tmp/draft.md')).toContain(dir);
  // The path to use is named whole, as the model would write it.
  expect(refused('/tmp/draft.md')).toContain('artifacts/draft.md');
  expect(refused('../draft.md')).toContain('artifacts/draft.md');
  expect(refused('../draft.md')).toContain('Nothing was changed');
  expect(refused('draft.md')).toContain('artifacts/draft.md');
  // The memory has its own tool and its own guards.
  expect(refused('memory/fact.md')).toContain('memory tool');
  expect(refused('artifacts/out/x.md')).toContain('outside the workspace');
  expect(refused('artifacts/link.md')).toContain('link');
  expect(fs.readdirSync(outside)).toEqual([]);
});

test('reading gives the file\'s text; listing walks the workspace and never follows a link', () => {
  const dir = fresh();
  writeArtifact(dir, 'artifacts/plan.md', 'the plan\n');
  fs.symlinkSync('/etc', path.join(dir, 'artifacts', 'etc'));
  expect(readWorkspaceFile(dir, 'artifacts/plan.md')).toBe('the plan\n');
  expect(() => readWorkspaceFile(dir, 'artifacts/etc/hosts')).toThrow('outside the workspace');
  expect(() => readWorkspaceFile(dir, 'artifacts/none.md')).toThrow('no such file');
  const listing = listWorkspace(dir, '');
  expect(listing).toContain('artifacts/plan.md (9 B)');
  expect(listing).toContain('artifacts/etc → a link, not followed');
  expect(listing).not.toContain('hosts');
  expect(listWorkspace(fresh(), '')).toContain('empty');
});
