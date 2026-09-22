// Where this installation lives, and its `.env` — settled before any other module of
// the host is evaluated.
//
// `cli.ts` imports this module FIRST. ES modules run in the order they are imported,
// and some of the host reads the environment as it loads (the config directory is
// fixed when `config/load.ts` is evaluated), so a `.env` loaded from `main` would
// arrive after those reads and apply to only half of the program. Bun loads the
// working directory's `.env` before any code runs; this does the same for the
// installation's own, as early as a module can. See `loader/install-root.ts` for how
// the root is chosen and why the `.env` never overrides the environment.
import { join } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { loadRootDotenv, resolveInstallRoot } from './loader/install-root.js';

export const { root: projectRoot, source: rootSource } = resolveInstallRoot({
  dirname: import.meta.dirname,
  execPath: process.execPath,
  cwd: process.cwd(),
  exists: existsSync,
  realpath: realpathSync,
});
export const availableDir = join(projectRoot, 'plugins-available');
export const enabledDir = join(projectRoot, 'plugins-enabled');

// A test imports `cli.ts` for its pure helpers; it must not pick up the variables of
// whatever checkout it runs in (the same test signal `sessionsDir` reads).
if (process.env.NODE_ENV !== 'test') {
  loadRootDotenv(projectRoot, process.cwd(), process.env, (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  });
}
