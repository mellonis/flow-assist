// Gitlab plugin builder — a tool group only (no surfaces,
// no views, no dependencies). The group is built with injectable deps;
// here defaults are supplied so the plugin is self-contained when the host
// doesn't override them. The host integration will inject the actual
// glab probe/runner.
import { buildGitlabGroup } from './tools.ts';

export function buildGitlabPlugin({ renders, config, make }: any) {
  const glabAvailable = async () => true;
  const runGlab = async () => '{}';
  return make('gitlab', {
    name: 'gitlab',
    tools: [buildGitlabGroup({ clip: (x: unknown) => x, glabAvailable, runGlab })],
    surface: undefined,
  });
}

export default buildGitlabPlugin;