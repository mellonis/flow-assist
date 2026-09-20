// Registry download for the plugin repository.
// `fetchPluginFromRegistry` returns the real `fetchPlugin` injected into
// `createPluginRepo`: when a plugin's source is absent locally,
// `install`/`update` call it to fetch the tarball from a GitLab Generic Packages
// Registry, extract it into `availableDir/<name>/`, and stamp the `.flow-assist-source`
// provenance marker so the repo can tell registry-managed plugins from git
// checkouts.
//
// The transport is injectable (`fetch`) so the module stays hermetic — the unit
// test feeds a fake `Response`; production wires `globalThis.fetch`. Extraction
// uses the system `tar` via `node:child_process` (macOS / Linux / GitLab CI all
// have tar; zero new dependencies and no network). Publish is the mirror-side
// function in `scripts/publish.ts`; this module is the download side only.

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The registry is read from the environment at construction and has NO built-in
// default: FLOW_ASSIST_PLUGIN_REGISTRY_URL (a GitLab `/api/v4` base) and
// FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT (numeric id or `group/project`). Unset, the host
// never contacts any server and a download names what to set. The token is
// read-only (sufficient for install/update): FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN, falling
// back to GITLAB_TOKEN. Publishing is gated on a separate write token (see
// scripts/publish.ts) and is NOT read here.
export const REGISTRY_NOT_CONFIGURED =
  'plugin registry is not configured — set FLOW_ASSIST_PLUGIN_REGISTRY_URL and FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT';
const TOKEN_ENVS = ['FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN', 'GITLAB_TOKEN'] as const;
// The provenance marker filename (matches repo.ts's `SOURCE_MARKER`), containing
// `registry\n`. Written after extraction so `list()`/`update()` can tell
// registry-managed plugins from git checkouts.
const SOURCE_MARKER = '.flow-assist-source';

export interface RegistryFetchOptions {
  baseUrl?: string;
  projectId?: string | number;
  token?: string;
  // The directory that holds plugin sources (`plugins-available/`). Required: the
  // fetcher untars into `join(availableDir, name)` and writes the `.flow-assist-source`
  // marker there. The repo (`createPluginRepo`) passes the SAME directory, so the
  // repo's own idempotent `writeSourceMarker(pluginDir)` lands on the same path.
  availableDir: string;
  // Injectable transport (default `globalThis.fetch`). Test-only: the unit test
  // passes a fake that returns a `Response` without touching the network.
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

// The shape `createPluginRepo`'s `fetchPlugin` expects.
export type RegistryFetch = (name: string, version?: string) => Promise<{ version: string }>;

// Shell-quote a single path/argument so tar/curl don't split on spaces or shell
// metacharacters. Wraps in single quotes, escaping embedded single quotes.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Numeric-aware semver-ish comparison. "newest" for the default-latest path is the
// highest dotted version; ties fall back to a lexical compare. Not exercised by
// the unit test (which supplies an explicit version) but kept correct.
function compareVersions(a: string, b: string): number {
  const pa = (a.split('-')[0] as string).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = (b.split('-')[0] as string).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return a.localeCompare(b);
}

export function fetchPluginFromRegistry(opts: RegistryFetchOptions): RegistryFetch {
  const baseUrl = (opts.baseUrl ?? process.env.FLOW_ASSIST_PLUGIN_REGISTRY_URL ?? '').replace(/\/+$/, '');
  const project = String(opts.projectId ?? process.env.FLOW_ASSIST_PLUGIN_REGISTRY_PROJECT ?? '');
  const configured = Boolean(baseUrl && project);
  // projectId may be a numeric ID or a URL-encoded slug (`group/project`); encode
  // so a slash in the slug becomes the GitLab `%2F` path segment.
  const projectPath = encodeURIComponent(project);
  const token = opts.token ?? TOKEN_ENVS.map((name) => process.env[name]).find(Boolean) ?? '';
  const { availableDir } = opts;
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  // Resolve the newest published version of a generic package by listing all
  // versions. GitLab returns them newest-first, but we sort defensively.
  const latestVersion = async (name: string): Promise<string> => {
    const url = `${baseUrl}/projects/${projectPath}/packages?name=${encodeURIComponent(name)}&per_page=100`;
    const res = await fetchImpl(url, { headers: { 'PRIVATE-TOKEN': token } });
    if (!res.ok) {
      throw new Error(`registry list failed (HTTP ${res.status}) for '${name}'`);
    }
    const body = (await res.json()) as Array<{ version?: string }>;
    const versions = body.filter((p) => p.version).map((p) => p.version as string);
    if (!versions.length) {
      throw new Error(`no published version of '${name}' in the registry`);
    }
    return versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  };

  // Download one version: GET the tarball, untar into `availableDir/<name>/`,
  // then write the `.flow-assist-source` provenance marker (the dir exists after untar).
  const download = async (name: string, version?: string): Promise<{ version: string }> => {
    if (!configured) throw new Error(REGISTRY_NOT_CONFIGURED);
    if (!token) {
      throw new Error('no FLOW_ASSIST_PLUGIN_REGISTRY_TOKEN set — set it to download plugins from the registry');
    }
    const resolved = version ?? (await latestVersion(name));

    const filename = `${name}-${resolved}.tar.gz`;
    const url = `${baseUrl}/projects/${projectPath}/packages/generic/${encodeURIComponent(name)}/${encodeURIComponent(resolved)}/${encodeURIComponent(filename)}`;

    const res = await fetchImpl(url, { headers: { 'PRIVATE-TOKEN': token } });
    if (!res.ok) {
      throw new Error(
        `download failed (HTTP ${res.status}) for ${name}@${resolved} — expected ${url}`,
      );
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    mkdirSync(availableDir, { recursive: true });
    // Untar from stdin into `availableDir`; the archive has a top-level `<name>/`.
    execSync(`tar -xzf - -C ${shq(availableDir)}`, { input: bytes });

    writeFileSync(join(availableDir, name, SOURCE_MARKER), 'registry\n', 'utf8');
    return { version: resolved };
  };

  return download;
}