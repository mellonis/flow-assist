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
    ],
    exec: async (name: string, args: any, ctx: any) => {
      if (name !== 'glab_api') throw new Error(`Unknown tool: ${name}`);
      // Validate BEFORE glab is touched (not even spawned): a bad method or an empty
      // path comes back as text — the model can fix its request.
      const method = String(args.method ?? 'GET').toUpperCase();
      if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) {
        return `Invalid method «${method}» — allowed GET/POST/PUT/PATCH/DELETE.`;
      }
      const path = String(args.path ?? '').trim();
      if (!path) return 'path is required — the GitLab API path.';
      // The path is glab's positional argument; one starting with `-` would be read
      // as a flag (`--input=<file>` uploads a file as the request body).
      if (path.startsWith('-')) return `Invalid path «${path}» — an API path cannot start with "-".`;
      if (!await glabAvailable()) return 'glab is not installed or not available in PATH.';
      const fields: Record<string, any> = {};
      for (const k of Object.keys(args.fields ?? {})) {
        // `--field k=v`, v being JSON for objects/arrays and a string otherwise. A
        // field name may not start with `-`, or it would smuggle a glab flag in.
        const fieldKey = String(k).trim();
        if (!fieldKey || fieldKey.startsWith('-')) continue;
        fields[fieldKey] = args.fields[k];
      }
      const argv = ['api', '--method', method, ...toFieldFlags(fields), path];
      return clip(await runGlab(argv));
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

export default buildGitlabGroup;