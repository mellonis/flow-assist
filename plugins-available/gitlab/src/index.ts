// Gitlab plugin builder — a tool-group-only plugin (no surfaces, no views). The group
// takes its `glab` probe and runner as deps so it stays testable without the binary;
// here they are the real ones (`./glab.ts`).
//
// Which GitLab it talks to is glab's own business — `glab auth login`, `GITLAB_HOST`,
// the repository's remote. The plugin adds no host or token setting of its own.
import { buildGitlabGroup } from './tools.ts';
import { createGlab } from './glab.ts';

export function buildGitlabPlugin({ make }: any) {
  const glab = createGlab();
  return make('gitlab', {
    name: 'gitlab',
    tools: [buildGitlabGroup({ clip: (x: unknown) => x, glabAvailable: glab.available, runGlab: glab.run })],
    surface: undefined,
  });
}

export default buildGitlabPlugin;
