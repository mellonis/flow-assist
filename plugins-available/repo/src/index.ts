// Repo plugin builder — a tool group only: no surfaces, no views, no dependencies.
// The group's roots allowlist is `plugins.repo.roots` — the plugin's own key, declared
// in its `configSchema` so `config set` and the model's config tool know it as repo's.
// When it is not set, repo reads the directories the host's shell works in,
// `shell.roots`, from the host config every builder is handed; after that the legacy
// `fs.roots`, the key both used to share (read for one release — the host logs where it
// moved). `clip` is the identity here.
import { buildRepoGroup } from './tools.ts';

type RootsConfig = { plugins?: { repo?: { roots?: unknown } }; shell?: { roots?: unknown }; fs?: { roots?: unknown } } | undefined;

// The first of the three keys that is SET — an array, even an empty one: `[]` is an
// answer ("no roots"), not an absence to fall through.
export function repoRoots(config: unknown): string[] {
  const c = config as RootsConfig;
  const raw = [c?.plugins?.repo?.roots, c?.shell?.roots, c?.fs?.roots].find(Array.isArray) ?? [];
  return (raw as unknown[]).filter((r): r is string => typeof r === 'string' && !!r);
}

// The settings, in the host's zod (handed in as `ctx.z`; an older host gave none).
function configSchema(z: any) {
  if (!z) return undefined;
  return z.object({ roots: z.array(z.string()).optional() }).optional();
}

export function buildRepoPlugin({ config, make, z }: any) {
  return make('repo', {
    name: 'repo',
    // Resolved on every call from the config object the host holds, never fixed at build.
    tools: [buildRepoGroup({ clip: (x: unknown) => x, roots: () => repoRoots(config) })],
    configSchema: configSchema(z),
    surface: undefined,
  });
}

export default buildRepoPlugin;
