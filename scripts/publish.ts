// Plugin publishing for the distribution layer.
// `publishPlugin` tars a plugin's available dir and uploads it to a GitLab Generic
// Packages Registry so the host (`fetchPluginFromRegistry`) can download it
// for `install`/`update`. Both the registry URL and the transport (`upload`) are
// injectable so the module is testable offline; production wires a
// `curl --upload-file` fallback and the GitLab package endpoint.
//
// Token is a WRITE token: `GITLAB_WRITE_TOKEN` (falling back to `CI_JOB_TOKEN` in a
// GitLab pipeline), distinct from the read-only `FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN` the host uses for
// install/update.
//
// This file is at the repo root (NOT under `src/`), so it is not typechecked or
// bundled by `tsc`; it is Bun-run via the `plugin:publish` npm script and imported
// by the unit test.

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No built-in registry: FLOW_ASSIST_PLUGIN_REGISTRY_URL / FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT (or the
// matching options) must name one, mirroring src/loader/registry-download.ts.
const REGISTRY_NOT_CONFIGURED =
  'plugin registry is not configured — set FLOW_ASSIST_PLUGIN_REGISTRY_URL and FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT';

export interface PublishOptions {
  availableDir: string;
  name: string;
  version?: string;
  token: string;
  baseUrl?: string;
  projectId?: string | number;
  // Inject the upload transport (test-only). Called as `upload(url, file)` where
  // `file` is the path to the built `{name}-{version}.tar.gz`. Defaults to a
  // `curl --upload-file` invocation via `node:child_process`.
  upload?: (url: string, file: string) => void | Promise<void>;
}

export interface PublishResult {
  ok: boolean;
  url?: string;
  error?: string;
}

// Shell-quote a single path/argument so curl doesn't split on spaces.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Read the plugin's version from its manifest.json (fall back to the arg).
function readVersion(manifestPath: string): string {
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
      if (m.version) return m.version;
    } catch {
      // fall through to the error below
    }
  }
  throw new Error(
    `cannot determine version for plugin — no version arg and no valid version in ${manifestPath}`,
  );
}

export async function publishPlugin(opts: PublishOptions): Promise<PublishResult> {
  const { availableDir, name, token } = opts;
  const version = opts.version ?? readVersion(join(availableDir, name, 'manifest.json'));
  const baseUrl = (opts.baseUrl ?? process.env.FLOW_ASSIST_PLUGIN_REGISTRY_URL ?? '').replace(/\/+$/, '');
  const project = String(opts.projectId ?? process.env.FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT ?? '');
  if (!baseUrl || !project) return { ok: false, error: REGISTRY_NOT_CONFIGURED };
  const projectPath = encodeURIComponent(project);
  const upload = opts.upload ?? ((url: string, file: string) => {
    execSync(
      `curl --header "PRIVATE-TOKEN: ${token}" --upload-file ${shq(file)} ${shq(url)}`,
      { stdio: 'inherit' },
    );
  });

  const filename = `${name}-${version}.tar.gz`;
  const url = `${baseUrl}/projects/${projectPath}/packages/generic/${encodeURIComponent(name)}/${encodeURIComponent(version)}/${encodeURIComponent(filename)}`;

  if (!token) {
    return {
      ok: false,
      error:
        'no write token set — set GITLAB_WRITE_TOKEN (or CI_JOB_TOKEN) to publish a plugin',
    };
  }

  let tarPath: string;
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'fa-pk-'));
    tarPath = join(tmp, filename);
    // Archive the plugin dir as a top-level `<name>/` into the tarball.
    execSync(`tar -czf ${shq(tarPath)} -C ${shq(availableDir)} ${shq(name)}`);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  try {
    await upload(url, tarPath);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, url };
}

// ─── CLI main guard ────────────────────────────────────────────────────────────
// `bun run plugin:publish <plugin-name>` — reads the plugin name from argv,
// resolves the manifest, publishes, and prints the resulting package URL.
if (import.meta.main) {
  (async () => {
    const name = process.argv[2];
    if (!name) {
      console.error('usage: bun run plugin:publish <plugin-name>');
      process.exit(1);
    }
    const availableDir = join(process.cwd(), 'plugins-available');
    const token = process.env.GITLAB_WRITE_TOKEN ?? process.env.CI_JOB_TOKEN ?? '';
    const res = await publishPlugin({ availableDir, name, token });
    if (res.ok) {
      console.log(`published ${name}: ${res.url}`);
    } else {
      console.error(res.error ?? 'publish failed');
      process.exit(1);
    }
  })();
}