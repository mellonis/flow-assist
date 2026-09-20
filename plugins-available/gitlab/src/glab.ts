// The real `glab` runner. It was a stub that answered every call with `{}`: the model
// saw five empty objects, concluded "glab is not authenticated" and told the person to
// log in — a confident diagnosis of a failure that was the plugin's own.
//
// Rules it holds:
//   - argv only, `shell: false` — nothing the model writes is ever parsed by a shell;
//   - a failure is REPORTED, never flattened into an empty success: the exit code and
//     glab's own stderr go back to the model, so what it tells the person is true;
//   - it cannot hang a turn: a timeout kills the process and says so.
import { spawn as nodeSpawn } from 'node:child_process';

type Spawn = typeof nodeSpawn;

export interface GlabOptions {
  bin?: string;
  timeoutMs?: number;
  spawn?: Spawn; // injectable for tests
}

export interface Glab {
  available(): Promise<boolean>;
  run(argv: string[]): Promise<string>;
}

interface Outcome { code: number | null; out: string; err: string; failed?: string }

export function createGlab({ bin = 'glab', timeoutMs = 30_000, spawn = nodeSpawn }: GlabOptions = {}): Glab {
  const exec = (argv: string[], limitMs: number): Promise<Outcome> => new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const done = (o: Outcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(o); } };
    let child: ReturnType<Spawn>;
    try {
      child = spawn(bin, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, out, err, failed: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ code: null, out, err, failed: `timed out after ${Math.round(limitMs / 1000)}s` }); }, limitMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => done({ code: null, out, err, failed: e.message }));
    child.on('close', (code) => done({ code, out, err }));
  });

  // Probed once: whether the binary exists does not change during a session.
  let probe: Promise<boolean> | null = null;

  return {
    available: () => (probe ??= exec(['--version'], 5_000).then((o) => !o.failed && o.code === 0)),
    async run(argv) {
      const o = await exec(argv, timeoutMs);
      if (o.failed) return `glab failed: ${o.failed}`;
      if (o.code !== 0) {
        // glab prints the API's error body on stdout and its own message on stderr.
        const detail = [o.err.trim(), o.out.trim()].filter(Boolean).join('\n').slice(0, 2000);
        return `glab exited with ${o.code}${detail ? `:\n${detail}` : ' and said nothing.'}`;
      }
      return o.out.trim() || '(glab returned an empty body)';
    },
  };
}
