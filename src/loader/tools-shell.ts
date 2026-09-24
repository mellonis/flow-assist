// The `shell` tool group: run_command — the model runs a shell command in the
// person's clone. Its own group, so `ai.disabledTools: ["shell"]` turns it off (core
// cannot be). The runner is the one `!command` uses (assistant/shell.ts); what makes
// this safe to offer is not the runner but the pause: the tool is a write, so EVERY
// call waits for the person's y/n with the command on screen, and a background task —
// nobody to ask — has it declined.
//
// The arguments are hostile input like any tool's (the model may have just read a
// ticket or a web page that told it what to write), and the y/n is the guard. The
// working directory is checked anyway: it must lie inside a configured root by its
// REAL path, so a symlink in a clone cannot carry the command out of it. It is the
// conversation's (`ctx.shell`, shared with `!command`) and remembered between calls.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { capConsoleText, consoleData } from '../assistant/console-view.js';
import { createShellState, dirAllowed, formatShell, nextCwd, realOf, runShell, shellCwd, shellLimits, shellRoots, tildePath, within, type ShellState } from '../assistant/shell.js';
import type { ToolGroup } from './tools.js';

// Where a call runs. No `cwd` — the conversation's directory (`base`). A `cwd` is a
// `cd` before the command: relative to `base`, or absolute, and it stays the
// conversation's directory afterwards. It must be an existing directory inside a
// root, spelled AND real. With roots configured, `base` itself must be inside them
// too (a first root that is missing falls back to the process's directory, which is
// not). A refusal throws: the host counts whatever a write tool returns as done.
export function commandCwd(config: Record<string, unknown>, asked: unknown, base: string = shellCwd(config)): string {
  const roots = shellRoots(config);
  const s = typeof asked === 'string' ? asked.trim() : '';
  if (!s) {
    if (roots.length && !dirAllowed(config, base)) throw new Error(`run_command: «${base}» is not a directory inside the configured roots`);
    return base;
  }
  if (!roots.length) throw new Error('run_command: no roots are configured (shell.roots), so cwd cannot be given — omit it');
  const abs = path.resolve(base, s);
  if (!roots.some((r) => within(abs, r))) throw new Error(`run_command: «${abs}» is outside the configured roots`);
  const real = realOf(abs);
  if (!roots.map(realOf).some((r) => within(real, r))) throw new Error(`run_command: «${abs}» resolves through a link to «${real}», outside the configured roots`);
  if (!dirAllowed(config, abs)) throw new Error(`run_command: «${abs}» is not a directory`);
  return abs;
}

// Which of the usual programs are on PATH — probed once per process, in ONE shell
// (`command -v` is a builtin, so an empty PATH answers "none", not an error). The
// model otherwise knows the machine only from its training.
export const PROBED = ['bun', 'node', 'npm', 'pnpm', 'yarn', 'git', 'glab', 'gh', 'make', 'python3', 'docker', 'go', 'cargo'];
export function probePrograms(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const r = spawnSync('/bin/sh', ['-c', `for c in ${PROBED.join(' ')}; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done`], { env, encoding: 'utf8', timeout: 2000 });
    return String(r.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => PROBED.includes(l));
  } catch {
    return [];
  }
}
let probed: string[] | null = null;
const programs = () => (probed ??= probePrograms());

export function platformLine(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === 'darwin') return `macOS (darwin ${arch}); BSD userland — e.g. \`sed -i ''\`, no \`grep -P\``;
  if (platform === 'linux') return `Linux ${arch}`;
  return `${platform} ${arch}`;
}

// Built at load and sent with every request, so it is kept short.
export function runCommandDescription(config: Record<string, unknown>, found: string[] = programs()): string {
  const roots = shellRoots(config);
  const { timeoutMs } = shellLimits(config);
  return [
    'Run a shell command in the person\'s clone, after the person confirms it (every call pauses for y/n; a background task cannot run it). Returns the exit code, duration and the end of the output; a non-zero exit is a result, not a failure of the tool.',
    `Machine: ${platformLine()}; run through /bin/sh -c, no stdin, no TTY. The directory is remembered between calls (and the person's own !commands) like a terminal's — a \`cd\` or the cwd argument moves it, within the roots; variables are not kept. It starts at ${roots[0] ?? 'the process\'s directory'}${roots.length > 1 ? ` (other roots: ${roots.slice(1).join(', ')})` : ''}.`,
    found.length ? `Installed: ${found.join(', ')}.` : '',
    'Before guessing a build/test command, read the project\'s package.json scripts / Makefile / README with read_file. Prefer the dedicated tools (git_*, read_file, search, list_dir) when they fit. Never for interactive programs (editors, pagers, prompts); a long-running server is killed at the time limit' + ` (${Math.round(timeoutMs / 1000)} s).`,
  ].filter(Boolean).join(' ');
}

export const shellTools = (config: Record<string, unknown>): ToolGroup => ({
  id: 'shell',
  alwaysOn: false,
  tools: [
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: runCommandDescription(config),
        parameters: { type: 'object', properties: {
          command: { type: 'string', description: 'The command line, as typed in a shell.' },
          cwd: { type: 'string', description: 'A cd before the command: relative to the current directory, or absolute; must be inside a configured root, and stays the directory afterwards.' },
        }, required: ['command'] },
      },
      write: true,
    },
  ],
  exec: async (name, args, ctx) => {
    if (name !== 'run_command') throw new Error(`Unknown tool: ${name}`);
    const cmd = String(args.command ?? '').trim();
    if (!cmd) throw new Error('run_command: command is required');
    // The conversation's directory — shared with the person's !commands. A caller with
    // no conversation (the one-shot CLI) starts at the default every time.
    const shell = (ctx as { shell?: ShellState }).shell ?? createShellState(() => config);
    const cwd = commandCwd(config, args.cwd, shell.cwd());
    if (typeof args.cwd === 'string' && args.cwd.trim()) shell.setCwd(cwd); // a cd: it holds even if the command then fails
    const { timeoutMs, maxChars } = shellLimits(config);
    // The turn's signal: Esc stops the answer, and with it the command it is waiting on.
    const signal = (ctx as { signal?: AbortSignal }).signal;
    // The person said yes, so they see what it prints — AS it prints (a live view,
    // src/assistant/views.ts): a line in the chat that a click opens. Display only:
    // the model reads the output through the result below, never a second copy.
    const live = (ctx as { liveView?: (k: string, d: unknown) => { update(d: unknown): void } }).liveView?.('console', { command: cmd, cwd: tildePath(cwd), text: '' });
    let raw = '';
    const onOutput = live
      ? (chunk: string) => { raw += chunk; if (raw.length > maxChars * 2) raw = raw.slice(-maxChars); live.update({ command: cmd, cwd: tildePath(cwd), text: capConsoleText(raw) }); }
      : undefined;
    const r = await runShell(cmd, { cwd, timeoutMs, maxChars, signal, ...(onOutput ? { onOutput } : {}) });
    if (r.error) throw new Error(`run_command: could not start /bin/sh: ${r.error}`);
    live?.update(consoleData(cmd, r, cwd, timeoutMs));
    const move = nextCwd(config, cwd, r.pwd);
    if (move.cwd !== cwd) shell.setCwd(move.cwd);
    return formatShell(cmd, r, cwd, timeoutMs, { after: move.cwd, note: move.note }).forTool;
  },
});
