// Repo plugin builder — a tool group only: no surfaces, no views, no dependencies.
// The group reads the roots allowlist from config.fs.roots; roots may be an array
// or a lazy-loader function, both supported by buildRepoGroup. `clip` is the
// identity here.
import { buildRepoGroup } from './tools.ts';

export function buildRepoPlugin({ renders, config, make }: any) {
  const roots = (config as any)?.fs?.roots ?? [];
  return make('repo', {
    name: 'repo',
    tools: [buildRepoGroup({ clip: (x: unknown) => x, roots })],
    surface: undefined,
  });
}

export default buildRepoPlugin;