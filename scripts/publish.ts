// Plugin publishing for the distribution layer.
// `publishPlugin` builds and packs a plugin (see "What a published plugin is") and uploads it to a GitLab Generic
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
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

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
  // Inject the build runner (test-only). Defaults to running the command in `cwd`.
  run?: (cmd: string, cwd: string) => void;
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

// ─── What a published plugin is ────────────────────────────────────────────────
// A published plugin ships NO `node_modules`. If it has dependencies it is BUILT
// first — its own `build` script bundles them into the one file `package.json`'s
// `main` names (React and flowtty stay external: the host provides them) — and the
// archive holds the manifest, package.json, the built entry's directory and the
// licence/readme. The host's loader already prefers `main` and only falls back to
// `src/` when it is missing.
//
// This is not a size optimisation. A `bun build --compile` host cannot import an
// on-disk package whose package.json has `exports` (see AGENTS.md, Stack), so a
// plugin installed WITH its node_modules is skipped by the single binary; a bundled
// one loads and renders. It also keeps a symlinked `file:` dependency — a path that
// exists on the author's machine only — out of the archive.
const NEVER_SHIPPED = ['node_modules', '__tests__', 'bun.lock', 'package-lock.json', 'tsconfig.json'];

export interface PackResult { ok: boolean; error?: string; built?: boolean; shipped?: string[] }

export function packPlugin(pluginDir: string, tarPath: string, run: (cmd: string, cwd: string) => void = (cmd, cwd) => { execSync(cmd, { cwd, stdio: 'inherit' }); }): PackResult {
  const pkgFile = join(pluginDir, 'package.json');
  const pkg = existsSync(pkgFile)
    ? (JSON.parse(readFileSync(pkgFile, 'utf8')) as { main?: string; files?: unknown[]; scripts?: Record<string, string>; dependencies?: Record<string, string> })
    : {};
  const deps = Object.keys(pkg.dependencies ?? {});
  const hasBuild = !!pkg.scripts?.build;
  if (deps.length && !hasBuild) {
    return { ok: false, error: `plugin has dependencies (${deps.join(', ')}) but no "build" script — a published plugin ships no node_modules, so they must be bundled into its "main"` };
  }
  if (hasBuild) {
    try { run('bun run build', pluginDir); } catch (e) { return { ok: false, error: `build failed: ${(e as Error).message}` }; }
    if (!pkg.main || !existsSync(join(pluginDir, pkg.main))) {
      return { ok: false, error: `build did not produce package.json "main" (${pkg.main ?? 'unset'})` };
    }
  }
  // A built plugin ships its build, not the sources it was built from — with both
  // present an install would work by accident if the build were broken.
  const skip = [...NEVER_SHIPPED, ...(hasBuild ? ['src'] : [])];
  // `files` in package.json, as npm reads it, names what ships — for a plugin whose
  // directory holds neighbours it builds from (a client package in a workspace).
  // The manifest and package.json always go.
  const listed = Array.isArray(pkg.files) ? ['manifest.json', 'package.json', ...pkg.files.map(String)] : null;
  // Dotfiles (.gitignore, .env, editor folders) are the author's, not the plugin's.
  const shipped = (listed ? [...new Set(listed)].filter((entry) => existsSync(join(pluginDir, entry))) : readdirSync(pluginDir))
    .filter((entry) => !entry.startsWith('.') && !skip.includes(entry))
    .sort();
  const name = basename(pluginDir);
  try {
    // `--exclude` reaches what the top-level filter cannot: a source-shipped plugin
    // keeps its tests under `src/__tests__`, and they are not part of the plugin.
    execSync(`tar -czf ${shq(tarPath)} --exclude='__tests__' --exclude='*.test.ts' --exclude='.DS_Store' -C ${shq(dirname(pluginDir))} ${shipped.map((e) => shq(join(name, e))).join(' ')}`);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, built: hasBuild, shipped };
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
    // The archive holds a top-level `<name>/` — built, and without node_modules.
    const packed = packPlugin(join(availableDir, name), tarPath, opts.run);
    if (!packed.ok) return { ok: false, error: packed.error };
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