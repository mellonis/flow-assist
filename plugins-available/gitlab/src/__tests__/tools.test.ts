import { describe, it, expect } from 'bun:test';
import { buildGitlabGroup } from '../tools.ts';

describe('gitlab tool group', () => {
  const group = buildGitlabGroup({ clip: (x: unknown) => x, glabAvailable: async () => true, runGlab: async () => '{}' });
  it('write predicate is true only for write methods', () => {
    const glab = group.tools[0];
    expect(glab.write({ method: 'POST' })).toBe(true);
    expect(glab.write({ method: 'GET' })).toBe(false);
  });
  // R14-A: source's valid-method regex is GET/POST/PUT/PATCH/DELETE, so DELETE is
  // VALID (the brief's literal case was wrong). Adapt to a genuinely-invalid method.
  // A refusal throws: the host counts whatever a write tool returns as done (✎).
  it('validates method and path before running — by throwing', async () => {
    await expect(group.exec('glab_api', { method: 'FOO', path: '/x' }, {})).rejects.toThrow(/Invalid method/);
    await expect(group.exec('glab_api', { method: 'POST' }, {})).rejects.toThrow(/path is required/);
  });
  it('a glab failure is an error, not a result', async () => {
    const g = buildGitlabGroup({ clip: (x: unknown) => x, glabAvailable: async () => true, runGlab: async () => 'glab exited with 1:\n403 Forbidden' });
    await expect(g.exec('glab_api', { method: 'POST', path: 'projects/1/merge_requests' }, {})).rejects.toThrow(/403 Forbidden/);
  });
  // glab's `--field` reads `@path` from a file; a model-spelled value must never
  // reach it. What actually goes to glab is asserted, not only what comes back.
  it('a string value is sent raw, so "@file" is a string and not a file to upload', async () => {
    const calls: string[][] = [];
    const g = buildGitlabGroup({ clip: (x: unknown) => x, glabAvailable: async () => true, runGlab: async (argv) => { calls.push(argv); return '{}'; } });
    await g.exec('glab_api', { method: 'GET', path: 'projects', fields: { search: '@/etc/passwd', per_page: 5, archived: false, labels: ['@a'], '-x': 'flag' } }, {});
    expect(calls).toEqual([[
      'api', '--method', 'GET',
      '--raw-field', 'search=@/etc/passwd',
      '--field', 'per_page=5',
      '--field', 'archived=false',
      '--raw-field', 'labels=["@a"]',
      'projects',
    ]]);
  });
  it('a path that is really a flag never reaches glab', async () => {
    const calls: string[][] = [];
    const g = buildGitlabGroup({ clip: (x: unknown) => x, glabAvailable: async () => true, runGlab: async (argv) => { calls.push(argv); return '{}'; } });
    await expect(g.exec('glab_api', { path: '--input=/etc/passwd' }, {})).rejects.toThrow(/cannot start with "-"/);
    expect(calls).toEqual([]);
  });
});

// The MR wrappers over a fake GitLab that answers only the paths it knows — a double
// that answered anything would pass a wrong path.
describe('merge request tools', () => {
  const P = 'group%2Fsub%2Fatlas';
  const setup = (open: any[] = []) => {
    const calls: string[][] = [];
    const answers: Record<string, unknown> = {
      [`projects/${P}/merge_requests?state=opened&source_branch=feature%2Fx`]: open,
      [`projects/${P}`]: { default_branch: 'main' },
      [`projects/${P}/merge_requests/221`]: { iid: 221, title: 'Dates', state: 'opened', draft: true, source_branch: 'feature/x', target_branch: 'main', detailed_merge_status: 'ci_must_pass', web_url: 'https://gl/mr/221', head_pipeline: { id: 900, status: 'failed', web_url: 'https://gl/p/900' } },
      [`projects/${P}/pipelines/900/jobs?scope[]=failed&per_page=50`]: [{ id: 5, name: 'e2e', stage: 'test', web_url: 'https://gl/j/5', allow_failure: false }],
      [`projects/${P}/pipelines?ref=feature%2Fx&per_page=1`]: [{ id: 901, status: 'running', web_url: 'https://gl/p/901' }],
    };
    const runGlab = async (argv: string[]) => {
      calls.push(argv);
      const path = argv.at(-1)!;
      if (argv[2] === 'POST' && path === `projects/${P}/merge_requests`) return JSON.stringify({ iid: 222, title: argv.find((a) => a.startsWith('title='))?.slice('title='.length), web_url: 'https://gl/mr/222' });
      if (!(path in answers)) return `glab exited with 1:\n404 ${path}`;
      return JSON.stringify(answers[path]);
    };
    const g = buildGitlabGroup({ clip: (x: unknown) => x, glabAvailable: async () => true, runGlab });
    return { g, calls };
  };

  it('status of an MR gives its pipeline and the failed jobs with links', async () => {
    const { g } = setup();
    const out = await g.exec('gitlab_mr_status', { project: 'group/sub/atlas', iid: 221 }, {}) as any;
    expect(out.mr).toMatchObject({ iid: 221, draft: true, mergeStatus: 'ci_must_pass', url: 'https://gl/mr/221' });
    expect(out.pipeline).toEqual({ id: 900, status: 'failed', url: 'https://gl/p/900' });
    expect(out.failedJobs).toEqual([{ id: 5, name: 'e2e', stage: 'test', url: 'https://gl/j/5', allowFailure: false }]);
  });

  it('a branch without an MR still shows its latest pipeline', async () => {
    const { g } = setup();
    const out = await g.exec('gitlab_mr_status', { project: 'group/sub/atlas', branch: 'feature/x' }, {}) as any;
    expect(out.mr).toBeNull();
    expect(out.pipeline).toEqual({ id: 901, status: 'running', url: 'https://gl/p/901' });
  });

  it('create_mr opens a draft into the default branch', async () => {
    const { g, calls } = setup();
    const out = String(await g.exec('gitlab_create_mr', { project: 'group/sub/atlas', sourceBranch: 'feature/x', title: 'Date filter' }, {}));
    const post = calls.find((c) => c[2] === 'POST')!;
    expect(post).toEqual(['api', '--method', 'POST',
      '--raw-field', 'source_branch=feature/x', '--raw-field', 'target_branch=main', '--raw-field', 'title=Draft: Date filter',
      `projects/${P}/merge_requests`]);
    expect(out).toContain('opened !222 (draft)');
    expect(out).toContain('https://gl/mr/222');
  });

  it('an MR already open from the branch is a refusal with its link; nothing is created', async () => {
    const { g, calls } = setup([{ iid: 221, web_url: 'https://gl/mr/221' }]);
    await expect(g.exec('gitlab_create_mr', { project: 'group/sub/atlas', sourceBranch: 'feature/x', title: 'T' }, {})).rejects.toThrow(/already open: !221 https:\/\/gl\/mr\/221\. Nothing was created/);
    expect(calls.some((c) => c[2] === 'POST')).toBe(false);
  });

  it('a project or branch that is really a flag or a URL is refused before glab', async () => {
    const { g, calls } = setup();
    for (const project of ['--input=/etc/passwd', 'https://evil/x', 'atlas', 'group/../etc']) {
      await expect(g.exec('gitlab_mr_status', { project, branch: 'feature/x' }, {})).rejects.toThrow(/not a project path/);
    }
    await expect(g.exec('gitlab_create_mr', { project: 'group/sub/atlas', sourceBranch: '--all', title: 'T' }, {})).rejects.toThrow(/not a branch name/);
    expect(calls).toEqual([]);
  });

  it('create_mr is a write tool; mr_status is not', () => {
    const { g } = setup();
    const def = (n: string) => g.tools.find((t: any) => t.function.name === n) as any;
    expect(def('gitlab_create_mr').write).toBe(true);
    expect(def('gitlab_mr_status').write).toBeUndefined();
  });
});