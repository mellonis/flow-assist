// The `gitlab` tool group for the chat, over the glab CLI. A self-contained factory:
// `glabAvailable`, `runGlab` and `clip` come in as deps, so the group is testable
// without a real glab binary, and it imports nothing from the host or React.
//
// glab_api is a deliberate write exception: the method is not restricted
// (GET/POST/PUT/PATCH/DELETE, writes to GitLab included). So `write` is a predicate:
// only a writing method asks for the y/n, a plain GET reads without a pause.
//
// `clip` post-processes every result (the plugin passes the identity).

type Clip = (value: unknown) => unknown;

type GitlabDeps = {
  clip: Clip;
  glabAvailable: () => Promise<boolean>;
  runGlab: (argv: string[]) => Promise<string>;
};

export function buildGitlabGroup({ clip, glabAvailable, runGlab }: GitlabDeps) {
  const isWrite = (a: any) => /^(POST|PUT|PATCH|DELETE)$/i.test(String(a?.method ?? 'GET'));
  return {
    id: 'gitlab',
    // Active only when glab is available (the probe is cached): the model is not
    // offered tools that would fail.
    detect: async () => glabAvailable(),
    tools: [
      {
        type: 'function',
        function: {
          name: 'glab_api',
          description: 'Send a GitLab REST API request via glab (https://docs.gitlab.com/ee/api/api_resources.html). path — the path relative to /api/v4 without the host (e.g. projects/:id/merge_requests/:iid, projects?search=…, projects/:id/issues/:iid, user, version, groups, projects/:id/pipelines/:pipeline_id, projects/:id/repository/commits/:sha). method — the HTTP method (GET by default). WARNING: method=POST/PUT/PATCH/DELETE — WRITE operations in GitLab (create/change/close/delete); use deliberately. fields — object of params for the request body (--field k=v), useful for POST/PUT. Result — the response body (JSON). Requires glab installed and authenticated.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'API path relative to /api/v4 (no host or prefix).' },
              method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method; GET by default. POST/PUT/PATCH/DELETE write to GitLab.' },
              fields: { type: 'object', description: 'Request body params (key-value pairs; objects/arrays as JSON).' },
            },
            required: ['path'],
          },
        },
        // A predicate: only writing methods ask for the y/n.
        write: isWrite,
      },
      {
        type: 'function',
        function: {
          name: 'gitlab_mr_status',
          description: 'The merge request of a branch and how its pipeline went: the open MR (iid, title, draft, state, link, whether it can merge), the latest pipeline (status, link) and its FAILED jobs with their links — enough to say what broke and where. project — the project path, e.g. "group/sub/project" (git_push returns it); branch — the source branch, OR iid — the MR number. Read-only.',
          parameters: { type: 'object', properties: {
            project: { type: 'string', description: 'Project path, e.g. group/sub/project.' },
            branch: { type: 'string', description: 'Source branch of the MR.' },
            iid: { type: 'number', description: 'MR number (instead of branch).' },
          }, required: ['project'] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'gitlab_create_mr',
          description: 'Open a merge request from a pushed branch. project — the project path (git_push returns it); sourceBranch — the branch; targetBranch — default: the project\'s default branch; title; description — optional; draft — default true (a draft MR). Refuses when an MR from that branch is already open (and gives its link). WRITE operation (the person confirms it).',
          parameters: { type: 'object', properties: {
            project: { type: 'string', description: 'Project path, e.g. group/sub/project.' },
            sourceBranch: { type: 'string' },
            targetBranch: { type: 'string', description: 'Default: the project default branch.' },
            title: { type: 'string' },
            description: { type: 'string' },
            draft: { type: 'boolean', description: 'Open as a draft (default true).' },
          }, required: ['project', 'sourceBranch', 'title'] },
        },
        write: true,
      },
    ],
    exec: async (name: string, args: any, ctx: any) => {
      // A refusal THROWS: the host counts whatever a write returns as done (✎), and a
      // failed read is better reported as a failure too.
      if (name === 'gitlab_mr_status' || name === 'gitlab_create_mr') {
        if (!await glabAvailable()) throw new Error('glab is not installed or not available in PATH.');
        return clip(await (name === 'gitlab_mr_status' ? mrStatus(args, runGlab) : createMr(args, runGlab)));
      }
      if (name !== 'glab_api') throw new Error(`Unknown tool: ${name}`);
      // Validate BEFORE glab is touched (not even spawned).
      const method = String(args.method ?? 'GET').toUpperCase();
      if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) {
        throw new Error(`Invalid method «${method}» — allowed GET/POST/PUT/PATCH/DELETE.`);
      }
      const path = String(args.path ?? '').trim();
      if (!path) throw new Error('path is required — the GitLab API path.');
      // The path is glab's positional argument; one starting with `-` would be read
      // as a flag (`--input=<file>` uploads a file as the request body).
      if (path.startsWith('-')) throw new Error(`Invalid path «${path}» — an API path cannot start with "-".`);
      if (!await glabAvailable()) throw new Error('glab is not installed or not available in PATH.');
      const fields: Record<string, any> = {};
      for (const k of Object.keys(args.fields ?? {})) {
        // `--field k=v`, v being JSON for objects/arrays and a string otherwise. A
        // field name may not start with `-`, or it would smuggle a glab flag in.
        const fieldKey = String(k).trim();
        if (!fieldKey || fieldKey.startsWith('-')) continue;
        fields[fieldKey] = args.fields[k];
      }
      const argv = ['api', '--method', method, ...toFieldFlags(fields), path];
      return clip(failed(await runGlab(argv)));
    },
  };
}

// glab's `--field` is the "magic" flag: a value starting with `@` is read FROM A
// FILE (`@-` from stdin). With it, `fields: { title: "@~/.ssh/id_ed25519" }` would
// send a private key to GitLab — and on a GET not even a y/n stands in the way.
// `--raw-field` sends the value as the literal string it is, so everything a model
// can spell goes through it; only numbers and booleans keep `--field`, for the type
// conversion, and neither can begin with `@`.
function toFieldFlags(fields: Record<string, any> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields || {})) {
    const key = String(k).trim();
    if (!key || key.startsWith('-')) continue;
    const typed = typeof v === 'number' || typeof v === 'boolean';
    out.push(typed ? '--field' : '--raw-field', `${key}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`);
  }
  return out;
}

// glab's runner reports a failure as text ("glab exited with 1: …") rather than
// throwing; here it becomes an error, so a failed write is not shown as done.
function failed(out: string): string {
  if (/^glab (exited with|failed:)/.test(out)) throw new Error(out);
  return out;
}

type Run = (argv: string[]) => Promise<string>;
const getJson = async (runGlab: Run, path: string): Promise<any> => {
  const out = failed(await runGlab(['api', '--method', 'GET', path]));
  try { return JSON.parse(out); } catch { throw new Error(`GitLab answered ${path} with something that is not JSON: ${out.slice(0, 200)}`); }
};

// A project path as GitLab names it (group/sub/project) — never a flag, never a URL.
function projectPath(raw: unknown): string {
  const p = String(raw ?? '').trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(p) || p.split('/').some((s) => s.startsWith('-') || s === '..' || s === '.')) {
    throw new Error(`«${String(raw ?? '')}» is not a project path like group/sub/project.`);
  }
  return encodeURIComponent(p);
}
function branchName(raw: unknown, what: string): string {
  const b = String(raw ?? '').trim();
  if (!b || b.startsWith('-') || /[\s~^:?*[\\]|\.\./.test(b)) throw new Error(`${what} «${b}» is not a branch name.`);
  return b;
}

async function mrStatus(args: any, runGlab: Run): Promise<unknown> {
  const project = projectPath(args.project);
  let mr: any;
  if (args.iid != null && String(args.iid).trim()) {
    const iid = Number(args.iid);
    if (!Number.isInteger(iid) || iid <= 0) throw new Error(`iid «${args.iid}» is not an MR number.`);
    mr = await getJson(runGlab, `projects/${project}/merge_requests/${iid}`);
  } else {
    const branch = branchName(args.branch, 'branch');
    const list = await getJson(runGlab, `projects/${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`);
    mr = Array.isArray(list) ? list[0] : undefined;
    if (!mr) {
      const pipes = await getJson(runGlab, `projects/${project}/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`);
      const p = Array.isArray(pipes) ? pipes[0] : undefined;
      return { mr: null, note: `no open merge request from «${branch}»`, pipeline: p ? { id: p.id, status: p.status, url: p.web_url } : null };
    }
  }
  const p = mr.head_pipeline ?? null;
  let failedJobs: unknown[] = [];
  if (p?.id && p.status === 'failed') {
    const jobs = await getJson(runGlab, `projects/${project}/pipelines/${p.id}/jobs?scope[]=failed&per_page=50`);
    failedJobs = (Array.isArray(jobs) ? jobs : []).map((j: any) => ({ id: j.id, name: j.name, stage: j.stage, url: j.web_url, allowFailure: j.allow_failure === true }));
  }
  return {
    mr: { iid: mr.iid, title: mr.title, state: mr.state, draft: mr.draft ?? mr.work_in_progress ?? false, source: mr.source_branch, target: mr.target_branch, mergeStatus: mr.detailed_merge_status ?? mr.merge_status, url: mr.web_url },
    pipeline: p ? { id: p.id, status: p.status, url: p.web_url } : null,
    failedJobs,
  };
}

async function createMr(args: any, runGlab: Run): Promise<string> {
  const project = projectPath(args.project);
  const source = branchName(args.sourceBranch, 'sourceBranch');
  const title = String(args.title ?? '').trim();
  if (!title) throw new Error('title is required — the merge request title. Nothing was created.');
  const open = await getJson(runGlab, `projects/${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(source)}`);
  if (Array.isArray(open) && open[0]) throw new Error(`a merge request from «${source}» is already open: !${open[0].iid} ${open[0].web_url}. Nothing was created.`);
  const target = args.targetBranch ? branchName(args.targetBranch, 'targetBranch') : String((await getJson(runGlab, `projects/${project}`)).default_branch ?? '');
  if (!target) throw new Error('the project has no default branch — pass targetBranch. Nothing was created.');
  if (target === source) throw new Error(`source and target are both «${source}». Nothing was created.`);
  const draft = args.draft !== false;
  const fullTitle = draft && !/^(draft:|\[draft\])/i.test(title) ? `Draft: ${title}` : title;
  const fields: Record<string, unknown> = { source_branch: source, target_branch: target, title: fullTitle };
  if (args.description != null && String(args.description).trim()) fields.description = String(args.description);
  const out = failed(await runGlab(['api', '--method', 'POST', ...toFieldFlags(fields), `projects/${project}/merge_requests`]));
  let mr: any;
  try { mr = JSON.parse(out); } catch { return out; }
  return `opened !${mr.iid}${draft ? ' (draft)' : ''}: ${mr.title} — ${source} → ${target}\n${mr.web_url}`;
}

export default buildGitlabGroup;