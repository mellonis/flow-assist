// `/mcp` in the chat and `:mcp` on the command line: the servers and what can be done to
// them, by the person — never a tool for the model (config is the person's).
//
//   /mcp                              the list: in the chat a panel with keys, on the line text
//   /mcp disable|enable <name>        off or on at once, saved (`--session`: this run only)
//   /mcp restart <name>               tried now, the backoff started over
//   /mcp add <name> <url | command…>  a new server, saved to config.local.json
//   /mcp remove <name>                gone from config.local.json and from the run
//   /mcp tools <name>                 its tools, the read-only ones marked
//
// `headers` and `env` are never taken here: they hold tokens, and a line typed in the
// chat is kept in its history and its session. They are set with `config set`, which
// keeps no history.

import type { ServerManager, ServerView } from './servers.ts';
import { inSeconds, toolName, type ServerSpec } from './index.ts';

type Services = {
  setConfig?: (key: string, value: unknown, opts?: { session?: boolean }) => { ok: boolean; error?: string; value?: unknown };
  unsetConfig?: (key: string, opts?: { session?: boolean }) => { ok: boolean; error?: string; value?: unknown };
  pushLog?: (line: string) => void;
};
type Ctx = {
  surface?: 'chat' | 'line';
  say?: (text: string) => void;
  showMessage?: (text: string) => void;
  error?: (text: string) => void;
  openPanel?: (spec: unknown) => void;
};

export const SUBCOMMANDS = ['disable', 'enable', 'restart', 'add', 'remove', 'tools', 'help'] as const;
const NAMED = new Set(['disable', 'enable', 'restart', 'remove', 'tools']);
const NAME = /^[A-Za-z0-9_-]+$/;

export const MCP_HELP = [
  '/mcp — the servers; in the chat a list with keys',
  '/mcp disable|enable <name> [--session] — off or on at once, saved (--session: this run only)',
  '/mcp restart <name> — try it now, the backoff started over',
  '/mcp add <name> <url | command args…> [--session] — a new server (a command is split on spaces, no shell)',
  '/mcp remove <name> — out of config.local.json and this run',
  '/mcp tools <name> — its tools, the read-only ones marked',
  'headers and env are never taken here — they hold secrets: config set plugins.mcp.servers.<name>.headers \'{…}\'',
].join('\n');

// What a server is doing, in a few words.
export function stateText(v: ServerView, now: number): string {
  if (v.state === 'connected') return `connected · ${v.tools.length} tools`;
  if (v.state === 'disabled') return 'disabled';
  if (v.state === 'connecting') return 'connecting…';
  return `failed — ${v.reason ?? 'no answer'}${v.nextAt !== undefined ? ` · retrying in ${inSeconds(v.nextAt, now)}` : ''}`;
}

export function serverRow(v: ServerView, now: number) {
  const readOnly = v.state === 'connected' && v.readOnly ? ` · ${v.readOnly} read-only` : '';
  return {
    id: v.name,
    text: v.name,
    detail: `${v.transport} · ${stateText(v, now)}${readOnly}`,
    ...(v.state === 'connected' ? { tone: 'ok' as const } : v.state === 'failed' ? { tone: 'error' as const } : {}),
  };
}

// The list as one line, for the `:` line's toast.
export const listLine = (views: ServerView[], now: number) =>
  views.length ? `mcp: ${views.map((v) => `${v.name} (${v.transport}) ${stateText(v, now)}`).join(' · ')}` : 'mcp: no servers — /mcp add <name> <url | command…>';

export function mcpCommand(manager: ServerManager, deps: { services: () => Services | undefined; now?: () => number }) {
  const now = deps.now ?? (() => Date.now());
  const names = () => manager.list().map((v) => v.name);

  const toolsPanel = (name: string) => ({
    title: `MCP · ${name} · tools`,
    empty: 'No tools — the server is not connected.',
    rows: () => {
      const v = manager.list().find((x) => x.name === name);
      if (!v) return [];
      const ro = readOnlyNames(manager, name);
      return v.tools.map((t) => ({ id: t.name, text: t.name, detail: `${ro.has(t.name) ? 'read-only · ' : ''}${(t.description ?? '').replace(/\s+/g, ' ').slice(0, 120)}`, ...(ro.has(t.name) ? { tone: 'ok' as const } : {}) }));
    },
  });

  const toggle = (name: string, on: boolean, session: boolean): string => {
    const svc = deps.services();
    if (!svc?.setConfig) throw new Error('mcp: this needs the app — config set plugins.mcp.servers.' + name + '.enabled ' + on);
    const res = svc.setConfig(`plugins.mcp.servers.${name}.enabled`, on, { session });
    if (!res.ok) throw new Error(res.error ?? 'mcp: could not save it');
    if (on) void manager.enable(name); else manager.disable(name);
    return `mcp: ${name} ${on ? 'enabled — connecting' : 'disabled'}${session ? ' for this run' : ' (saved)'}`;
  };

  const panel = () => ({
    title: `MCP servers · ${manager.list().length}`,
    empty: 'No servers — /mcp add <name> <url | command…>',
    rows: () => { const t = now(); return manager.list().map((v) => serverRow(v, t)); },
    keys: [
      { key: 'd', label: 'disable / enable', run: (id: string | null) => {
        if (!id) return '';
        const v = manager.list().find((x) => x.name === id);
        return toggle(id, v?.state === 'disabled', false);
      } },
      { key: 'r', label: 'restart', run: (id: string | null) => (id ? (manager.restart(id) ? `mcp: restarting ${id}` : `mcp: ${id} is disabled — d enables it`) : '') },
      { key: 't', label: 'tools', run: (id: string | null) => (id ? toolsPanel(id) : '') },
    ],
  });

  // A refusal is said where the command ran: the chat's error line, the `:` line's toast.
  const run = (ctx: Ctx = {}, arg = ''): void => {
    try { act(ctx, arg); } catch (e) {
      const message = (e as Error).message;
      if (ctx.surface === 'chat' && ctx.error) ctx.error(message); else ctx.showMessage?.(message);
    }
  };
  const act = (ctx: Ctx, arg: string): void => {
    const chat = ctx.surface === 'chat';
    const say = (text: string) => (chat ? ctx.say?.(text) : ctx.showMessage?.(text.split('\n')[0]!));
    const words = arg.trim().split(/\s+/).filter(Boolean);
    const session = words.includes('--session');
    const [sub, name, ...rest] = words.filter((w) => w !== '--session');
    if (!sub) {
      if (chat && ctx.openPanel) { ctx.openPanel(panel()); return; }
      const t = now();
      for (const v of manager.list()) deps.services()?.pushLog?.(`[mcp] ${v.name} (${v.transport}): ${stateText(v, t)}`);
      say(listLine(manager.list(), t));
      return;
    }
    const verb = sub.toLowerCase();
    if (verb === 'help' || !(SUBCOMMANDS as readonly string[]).includes(verb)) { say(verb === 'help' ? MCP_HELP : `mcp: no such action "${sub}"\n${MCP_HELP}`); return; }
    if (!name) throw new Error(`mcp: ${verb} takes a server's name — /mcp help`);
    if (NAMED.has(verb) && !manager.has(name)) throw new Error(`mcp: no server "${name}"${names().length ? ` — there are ${names().join(', ')}` : ''}`);
    switch (verb) {
      case 'disable': say(toggle(name, false, session)); return;
      case 'enable': say(toggle(name, true, session)); return;
      case 'restart':
        if (!manager.restart(name)) throw new Error(`mcp: ${name} is disabled — /mcp enable ${name}`);
        say(`mcp: restarting ${name}`);
        return;
      case 'tools': {
        if (chat && ctx.openPanel) { ctx.openPanel(toolsPanel(name)); return; }
        const v = manager.list().find((x) => x.name === name)!;
        const ro = readOnlyNames(manager, name);
        say(v.tools.length ? `mcp: ${name} — ${v.tools.map((t) => `${t.name}${ro.has(t.name) ? ' (read-only)' : ''}`).join(', ')}` : `mcp: ${name} has no tools — ${stateText(v, now())}`);
        return;
      }
      case 'add': {
        if (!NAME.test(name)) throw new Error(`mcp: a server's name is letters, digits, - and _ — "${name}" is not`);
        if (manager.has(name)) throw new Error(`mcp: "${name}" is there already — /mcp remove ${name} first`);
        if (!rest.length) throw new Error(`mcp: add ${name} <url | command args…>`);
        const spec: ServerSpec = /^https?:\/\//i.test(rest[0]!) && rest.length === 1 ? { url: rest[0]! } : { command: rest[0]!, ...(rest.length > 1 ? { args: rest.slice(1) } : {}) };
        const svc = deps.services();
        if (!svc?.setConfig) throw new Error('mcp: this needs the app — config set plugins.mcp.servers.<name>.url …');
        const res = svc.setConfig(`plugins.mcp.servers.${name}`, spec, { session });
        if (!res.ok) throw new Error(res.error ?? 'mcp: could not save it');
        void manager.add(name, spec);
        say(`mcp: added ${name}${session ? ' for this run' : ' (saved)'} — connecting; headers and env are set with config set`);
        return;
      }
      case 'remove': {
        const svc = deps.services();
        if (!svc?.unsetConfig) throw new Error(`mcp: this needs the app — config unset plugins.mcp.servers.${name}`);
        const res = svc.unsetConfig(`plugins.mcp.servers.${name}`, { session });
        if (!res.ok) throw new Error(res.error ?? 'mcp: could not remove it');
        // What is left is config.json's, which this command does not write.
        if (res.value !== undefined) throw new Error(`mcp: ${name} is set in config.json — remove it there, or /mcp disable ${name}`);
        manager.remove(name);
        say(`mcp: removed ${name}`);
        return;
      }
    }
  };

  // Completion: the actions, then a server's name, then `--session` where it means something.
  const complete = (words: string[]) => {
    if (words.length === 0) return [...SUBCOMMANDS];
    const verb = words[0]!.toLowerCase();
    if (words.length === 1 && NAMED.has(verb)) { const t = now(); return manager.list().map((v) => ({ value: v.name, label: stateText(v, t) })); }
    if (words.length === 2 && (verb === 'disable' || verb === 'enable')) return ['--session'];
    return [];
  };

  return {
    name: 'mcp',
    usage: 'mcp [disable|enable|restart|add|remove|tools|help] …',
    description: 'MCP servers: list, disable/enable, restart, add, remove, tools',
    chat: true,
    minArgs: 0,
    maxArgs: -1,
    complete,
    run,
  };
}

// The names of a server's tools that run without asking, as the group marks them.
function readOnlyNames(manager: ServerManager, name: string): Set<string> {
  const group = manager.groups().find((g) => g.id === `mcp:${name}`);
  const v = manager.list().find((x) => x.name === name);
  if (!group || !v) return new Set();
  const free = new Set(group.tools.filter((t) => !t.write).map((t) => t.function.name));
  return new Set(v.tools.filter((t) => free.has(toolName(name, t.name))).map((t) => t.name));
}
