// The servers over the run: each one's state, and getting it back when it is not there.
//
// A server is `connecting`, `connected`, `failed` or `disabled`. One that fails to
// connect — at start or later — or drops once connected (a call finds the line refused
// or reset or a gateway's 502/503/504, a stdio process exits; a call that timed out or
// got another 5xx or a 404 drops it only when a `ping` after it gets no answer either)
// is tried again in the background,
// after 5 s, 15 s and 60 s, then every 5 minutes, until it answers. A 401 or 403 is not
// tried again: that is the token, not the network, and the reason says so; `restart`
// tries it again once the person has fixed it. A server that connects hands its group
// to `onChange`, which puts it into the tool index (the plugin calls the host's
// `toolsChanged`); one that connects after its first attempt is said in the chat too.
// The first attempts run in the background (`start`): the app draws without them.
//
// Every attempt carries the server's generation: `disable`, `restart` and `remove` start
// a new one, and an attempt that finishes under an older generation lets go of what it
// made rather than bringing back a group the person has just turned off.
//
// The timers never hold the program open (unref'd, so `config set plugins.…` still
// exits), and `stop` clears them all — the plugin calls it when the program exits.

import { McpError, createMcpClient as createHttp, type Fetcher, type McpClient, type McpTool } from './client.ts';
import { createStdioClient } from './stdio.ts';
import { inSeconds, specProblem, toolGroup, unknownReadOnly, type ServerSpec } from './index.ts';

export type ServerState = 'connecting' | 'connected' | 'failed' | 'disabled';

// When a server that is not there is tried again: after each of `delays` in turn, then
// every `every`.
export type RetrySchedule = { delays: number[]; every: number };
export const RETRY: RetrySchedule = { delays: [5_000, 15_000, 60_000], every: 300_000 };

// The clock and the timers — injected, so a test runs the schedule without waiting it.
export type Timers = {
  now: () => number;
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};
export const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

type Group = ReturnType<typeof toolGroup>;

export type ServerView = {
  name: string;
  transport: 'http' | 'stdio';
  state: ServerState;
  // Why it failed, as the server or the line said it.
  reason?: string;
  // When it is tried next (a clock time), absent when it is not.
  nextAt?: number;
  // A 401/403: not tried again until `restart`.
  auth?: boolean;
  tools: McpTool[];
  // The tools that run without asking — the person's `readOnly`, or `trusted` and the
  // server's own read-only claim.
  readOnly: number;
  // The server's own name and version, once it answered.
  detail?: string;
  unknownReadOnly?: string[];
};

type Entry = ServerView & {
  spec: ServerSpec;
  // The question in flight whether the server is there — one at a time.
  checking?: Promise<Verdict>;
  gen: number;
  attempt: number;
  timer?: unknown;
  client?: McpClient;
  group?: Group;
};

export type ServerEvent =
  // It connected — `first` on the first attempt at it, else after a retry, a restart,
  // an enable, an add.
  | { kind: 'connected'; name: string; tools: number; first?: true }
  // It failed, on its first attempt (`first`) or later, or dropped.
  | { kind: 'failed'; name: string; reason: string; retryInMs?: number; auth?: boolean; first?: true }
  | { kind: 'dropped'; name: string; reason: string };

export type ManagerDeps = {
  fetch?: Fetcher;
  env?: Record<string, string | undefined>;
  schedule?: RetrySchedule;
  timers?: Timers;
  // Something changed that the tool index or the list shows.
  onChange?: (event?: ServerEvent) => void;
};

const expand = (s: string, env: Record<string, string | undefined>) => s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v: string) => env[v] ?? '');

// The reason a 401/403 is given: the server refused the credentials, so trying again
// would only be refused again.
export const authReason = (status: number) => `HTTP ${status} — the server refuses the token (headers), not tried again; fix it, then /mcp restart`;

const isAuth = (e: unknown) => e instanceof McpError && (e.status === 401 || e.status === 403);
// A call that says the connection is gone, rather than that the call failed: the line
// refused or reset, a gateway's 502/503/504, a stdio process gone.
const TRANSPORT_STATUS = new Set([502, 503, 504]);
const isLost = (e: unknown) => e instanceof McpError && (e.lost === true || (e.status !== undefined && TRANSPORT_STATUS.has(e.status)));
// A call that failed in a way that may be the call's or the server's: no answer in time
// (a slow search), a server error, a 404 (the tool's own "not found", or a session the
// server forgot). The server is asked whether it is there (`ping`): an answer keeps it
// and the call's error goes to the model; a 404 to the ping too is the session, and a
// new one is started and the call made again, once; no answer drops it. Anything else —
// a 401, a 400 — is that call's error alone.
const isDoubt = (e: unknown) => e instanceof McpError && (e.timeout === true || (e.status !== undefined && (e.status >= 500 || e.status === 404)));
type Verdict = 'kept' | 'retry' | 'dropped';

export function createServerManager(servers: Array<{ name: string; spec: ServerSpec }>, deps: ManagerDeps = {}) {
  const env = deps.env ?? process.env;
  const schedule = deps.schedule ?? RETRY;
  const timers = deps.timers ?? realTimers;
  const entries = new Map<string, Entry>();
  let stopped = false;

  const make = (name: string, spec: ServerSpec): Entry => ({
    name, spec, transport: spec.command !== undefined ? 'stdio' : 'http',
    state: spec.enabled === false ? 'disabled' : 'connecting', tools: [], readOnly: 0, gen: 0, attempt: 0,
  });
  for (const { name, spec } of servers) entries.set(name, make(name, spec));

  const changed = (event?: ServerEvent) => deps.onChange?.(event);

  // Lets go of whatever the server holds now: its timer, its client, its group.
  const letGo = (e: Entry) => {
    if (e.timer !== undefined) { timers.clear(e.timer); e.timer = undefined; }
    e.nextAt = undefined;
    const client = e.client;
    e.client = undefined;
    e.group = undefined;
    try { client?.close(); } catch { /* already gone */ }
  };

  const clientFor = (e: Entry, gen: number): McpClient => {
    const { spec, name } = e;
    const timeouts = { timeoutMs: spec.timeoutMs, connectTimeoutMs: spec.connectTimeoutMs };
    if (spec.command !== undefined) {
      return createStdioClient({
        name,
        command: spec.command,
        args: spec.args,
        env: Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, expand(String(v), env)])),
        ...timeouts,
        onDead: (err) => lost(e, gen, err),
      });
    }
    return createHttp({
      url: expand(spec.url!, env),
      headers: Object.fromEntries(Object.entries(spec.headers ?? {}).map(([k, v]) => [k, expand(String(v), env)])),
      fetch: deps.fetch,
      ...timeouts,
    });
  };

  // Tried again after the next delay of the schedule — never after a 401/403, never
  // for a server turned off, never once stopped.
  const retryLater = (e: Entry) => {
    if (stopped || e.auth || e.state === 'disabled') return undefined;
    const delay = e.attempt < schedule.delays.length ? schedule.delays[e.attempt]! : schedule.every;
    e.attempt++;
    e.nextAt = timers.now() + delay;
    const gen = e.gen;
    e.timer = timers.set(() => {
      e.timer = undefined;
      if (gen !== e.gen || stopped) return;
      void connect(e, true);
    }, delay);
    return delay;
  };

  const fail = (e: Entry, err: unknown, later: boolean) => {
    const auth = isAuth(err);
    e.state = 'failed';
    e.auth = auth || undefined;
    e.reason = auth ? authReason((err as McpError).status!) : (err as Error)?.message ?? String(err);
    e.tools = [];
    e.readOnly = 0;
    const retryInMs = retryLater(e);
    changed({ kind: 'failed', name: e.name, reason: e.reason, ...(retryInMs !== undefined ? { retryInMs } : {}), ...(auth ? { auth } : {}), ...(later ? {} : { first: true as const }) });
  };

  // A connected server's line went down (a call found it so, or its process exited):
  // its group goes — a tool that cannot work is not offered — and it is tried again.
  const lost = (e: Entry, gen: number, err: unknown) => {
    if (gen !== e.gen || e.state !== 'connected') return;
    e.gen++;
    letGo(e);
    const reason = isAuth(err) ? authReason((err as McpError).status!) : (err as Error)?.message ?? String(err);
    changed({ kind: 'dropped', name: e.name, reason });
    fail(e, err, true);
  };

  // Is the server there? One question at a time per server. A 404 to the ping is a
  // session the server forgot: a new one is started (the client drops its session id),
  // and the call is made again. A server that does not answer is dropped with the
  // ping's own reason.
  const check = (e: Entry, gen: number, client: McpClient & { forgetSession?: () => void }): Promise<Verdict> => {
    e.checking ??= (async (): Promise<Verdict> => {
      try {
        await client.ping();
        return 'kept';
      } catch (err) {
        if (err instanceof McpError && err.status === 404 && client.forgetSession) {
          try {
            client.forgetSession();
            await client.initialize();
            return gen === e.gen ? 'retry' : 'dropped';
          } catch (again) { lost(e, gen, again); return 'dropped'; }
        }
        lost(e, gen, err);
        return 'dropped';
      }
    })().finally(() => { e.checking = undefined; });
    return e.checking;
  };
  // What a call to a group that no longer answers is told.
  const notConnected = (e: Entry): string =>
    e.state === 'disabled' ? `${e.name} is disabled`
    : e.state === 'connected' ? `${e.name} was connected again since — call the tool again`
    : e.nextAt !== undefined ? `${e.name} is not connected — retrying in ${inSeconds(e.nextAt, timers.now())}`
    : `${e.name} is not connected — ${e.reason ?? 'no answer'}`;

  // One attempt. `later` — not the first: its success is news for the chat.
  async function connect(e: Entry, later: boolean): Promise<void> {
    const problem = specProblem(e.spec);
    if (problem) {
      e.state = 'failed';
      e.reason = problem;
      changed({ kind: 'failed', name: e.name, reason: problem, ...(later ? {} : { first: true as const }) });
      return;
    }
    const gen = ++e.gen;
    letGo(e);
    e.state = 'connecting';
    e.reason = undefined;
    e.auth = undefined;
    if (later) changed();
    const client = clientFor(e, gen);
    e.client = client;
    try {
      // Both steps are bounded by `connectTimeoutMs` each.
      const info = await client.initialize();
      const tools = await client.listTools();
      if (gen !== e.gen) { try { client.close(); } catch { /* gone */ } return; }
      const group = toolGroup(e.name, e.spec, client, tools, info.instructions, {
        onFail: (err) => {
          if (isLost(err)) { lost(e, gen, err); return 'dropped'; }
          return isDoubt(err) ? check(e, gen, client) : 'kept';
        },
        status: () => (gen === e.gen && e.state === 'connected' ? null : notConnected(e)),
      });
      e.state = 'connected';
      e.attempt = 0;
      e.group = group;
      e.tools = tools;
      e.readOnly = group.tools.filter((t) => !t.write).length;
      e.detail = `${info.serverName ?? 'server'}${info.serverVersion ? ` ${info.serverVersion}` : ''}`;
      const unknown = unknownReadOnly(e.spec, tools);
      e.unknownReadOnly = unknown.length ? unknown : undefined;
      changed({ kind: 'connected', name: e.name, tools: tools.length, ...(later ? {} : { first: true as const }) });
    } catch (err) {
      if (gen !== e.gen) return;
      // A server started as a command that did not make it through the handshake is
      // stopped, not left running for nothing.
      e.client = undefined;
      try { client.close(); } catch { /* gone */ }
      fail(e, err, later);
    }
  }

  const get = (name: string) => entries.get(name);

  return {
    // The first attempt at every server not turned off, all at once; it settles once
    // each has connected or failed. Nobody waits for it but the one-shot prompt and the
    // CLI (the plugin's `ready`). A server that fails here is tried again in the
    // background.
    async start(): Promise<void> {
      await Promise.all([...entries.values()].filter((e) => e.state !== 'disabled').map((e) => connect(e, false)));
    },
    // The groups of the servers connected now, in the order they are configured.
    groups(): Group[] {
      return [...entries.values()].flatMap((e) => (e.state === 'connected' && e.group ? [e.group] : []));
    },
    list(): ServerView[] {
      return [...entries.values()].map(({ spec: _s, gen: _g, attempt: _a, timer: _t, client: _c, group: _gr, checking: _ch, ...view }) => ({ ...view }));
    },
    has: (name: string) => entries.has(name),
    // Off at once: its group goes, a stdio process is stopped, no retry is left.
    disable(name: string): boolean {
      const e = get(name);
      if (!e) return false;
      e.gen++;
      letGo(e);
      e.state = 'disabled';
      e.reason = undefined;
      e.auth = undefined;
      e.attempt = 0;
      e.tools = [];
      e.readOnly = 0;
      changed();
      return true;
    },
    // On again: connected now, and tried again as ever when it does not answer.
    enable(name: string): Promise<void> | null {
      const e = get(name);
      if (!e) return null;
      e.attempt = 0;
      e.spec = { ...e.spec, enabled: true };
      return connect(e, true);
    },
    // Now, whatever it is doing — the backoff starts over.
    restart(name: string): Promise<void> | null {
      const e = get(name);
      if (!e || e.state === 'disabled') return null;
      e.attempt = 0;
      return connect(e, true);
    },
    add(name: string, spec: ServerSpec): Promise<void> {
      const e = make(name, spec);
      entries.set(name, e);
      changed();
      return connect(e, true);
    },
    remove(name: string): boolean {
      const e = get(name);
      if (!e) return false;
      e.gen++;
      letGo(e);
      entries.delete(name);
      changed();
      return true;
    },
    // Every timer cleared and every client let go: the program is ending.
    stop(): void {
      stopped = true;
      for (const e of entries.values()) { e.gen++; letGo(e); }
    },
  };
}
export type ServerManager = ReturnType<typeof createServerManager>;
