// Where the host finds its plugins and its `.env`.
//
// The plugin directories (`plugins-available/`, `plugins-enabled/`) sit beside the
// program: in a source checkout that is the repository root, one directory up from
// `src/cli.ts`; in a `bun build --compile` binary it is the directory the binary was
// installed in. The binary cannot learn that from `import.meta.dirname` — inside it
// that is the virtual `bunfs` — so it used to fall back to the working directory, and
// a binary started from anywhere else ran with no plugins and said nothing. The real
// location is `process.execPath`, taken through `realpath` so that a link to the
// binary (`/usr/local/bin/flow-assist`) still leads to the directory it lives in.
//
// Bun reads `.env` from the working directory only, so a `.env` kept beside the binary
// (the variables its plugins need) was skipped the same way. It is loaded here when
// the root is not the working directory, and it never overrides a variable the
// environment already has: what the person exported for this one run wins.
//
// Everything is pure over injected inputs, so the resolution is tested without a
// compiled binary.
import { join, dirname, resolve } from 'node:path';

export type RootSource = 'checkout' | 'binary' | 'cwd';

export interface RootInputs {
  // `import.meta.dirname` of the entry module (`src/`).
  dirname: string;
  // `process.execPath`: the compiled binary itself, or the `bun` running the sources.
  execPath: string;
  cwd: string;
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
}

// The virtual filesystem a compiled binary's modules live in: `/$bunfs/root` on
// macOS and Linux, `B:\~BUN\root` on Windows.
const inBundle = (dir: string) => dir.includes('bunfs') || dir.includes('~BUN');

const hasPluginDirs = (root: string, exists: RootInputs['exists']) =>
  exists(join(root, 'plugins-available')) && exists(join(root, 'plugins-enabled'));

// The first of: a source checkout (the directory above `src/`), the directory of the
// real binary, the working directory — the first two only when both plugin
// directories are there, the last one always, as the place to report.
export function resolveInstallRoot({ dirname: dir, execPath, cwd, exists, realpath }: RootInputs): { root: string; source: RootSource } {
  if (!inBundle(dir)) {
    const checkout = resolve(dir, '..');
    if (hasPluginDirs(checkout, exists)) return { root: checkout, source: 'checkout' };
  }
  let binDir: string | null = null;
  try {
    binDir = dirname(realpath(execPath));
  } catch {
    // An execPath that cannot be resolved leaves the working directory.
  }
  if (binDir && hasPluginDirs(binDir, exists)) return { root: binDir, source: 'binary' };
  return { root: cwd, source: 'cwd' };
}

// A `.env` file as Bun reads the simple cases: `KEY=VALUE` per line, `#` comments,
// an optional `export ` before the key, one pair of matching quotes around the value
// stripped. No expansion of `$VAR` and no multi-line values — a file that needs them
// is better loaded by the shell that starts the program.
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // An unquoted value ends at a comment that is set off by whitespace.
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]!] = value;
  }
  return out;
}

// Sets every variable the environment does not have yet; returns the names it set.
export function applyDotenv(vars: Record<string, string>, env: Record<string, string | undefined>): string[] {
  const set: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    set.push(key);
  }
  return set;
}

// Loads `<root>/.env` when the root is not the working directory (Bun has already
// read the working directory's). Returns the file it read, or null.
export function loadRootDotenv(
  root: string,
  cwd: string,
  env: Record<string, string | undefined>,
  read: (path: string) => string | null,
): string | null {
  if (resolve(root) === resolve(cwd)) return null;
  const file = join(root, '.env');
  const text = read(file);
  if (text == null) return null;
  applyDotenv(parseDotenv(text), env);
  return file;
}

// What to say when no plugin is enabled — where the host looked, so a binary started
// from the wrong place is not simply quieter than usual. Null when there are plugins.
export function noPluginsNote(enabledDir: string, enabledCount: number, exists: (path: string) => boolean): string | null {
  if (enabledCount > 0) return null;
  return exists(enabledDir) ? `no plugins in ${enabledDir}` : `no plugins: ${enabledDir} does not exist`;
}
