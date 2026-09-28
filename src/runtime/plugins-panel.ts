// `:plugins` — the plugins and what the person can do to them, as `/mcp` is for servers.
// The runtime's, not the chat's: it works with the chat closed and without the assistant
// plugin at all, which is what makes it the place to fix a broken plugin. `/plugins` in
// the chat opens the same panel in the chat's frame (the command is `chat: true`); the
// chat only draws it.
//
// One row per plugin — enabled, disabled, starting, skipped, not trusted — with its
// version, its state and what it brings (tool groups, tools, keys). The keys:
//   ⏎  details — what it is, the ranges it declares, why it was skipped, its settings
//   r  restart — a remote plugin's process stopped and started again, through the same
//      path a plugin that joins after the first frame takes
//   d  disable / enable — its link moved to `plugins-enabled/.disabled/` and back
//   t  tools — its tools, the ones that ask first marked
//   y  trust — the person's word, as `flow-assist plugins trust` gives it: a link that
//      leads elsewhere than it did shows both places and asks for a second `y`
// Installing, removing and updating stay the CLI's and the model's tools; the panel shows
// what they did once it is opened again.
//
// Trust is the person's alone: the `y` here is a key pressed in this panel. Nothing the
// model can call reaches it — no tool, no line typed into the chat's queue, no request a
// remote plugin can make.
//
// `rows()` is read at every draw and every second, so it reads no disk: what the
// repository says (versions, missing settings, what is disabled) is read when the panel
// opens and after each action; what changes on its own (starting, joined, skipped) is
// read live from the App.
import type { Plugin } from '../loader/plugin.js';
import type { PluginRepo, RepoEntry } from '../loader/repo.js';
import { DISABLED_DIR, checkPluginTrust, shownName, trustPlugin, untrustedText, type TrustOptions, type Untrusted } from '../loader/trust.js';
import { readPluginManifest } from '../loader/compat.js';
import { isRemotePlugin } from '../remote/index.js';
import { flattenConfigPaths } from '../config/commands.js';
import { shownValue } from '../config/load.js';
import { bindingGlyph } from '../playback/keys.js';
import type { PanelRow, PanelSpec } from '../assistant/command-panel.js';
import { join } from 'node:path';

// What the loader knew, kept for the panel: where the plugins are and how to load one
// again (`loadEnabledPlugin`), why each was skipped, which the person has not trusted.
export interface PluginSite {
  repo?: Pick<PluginRepo, 'list' | 'enabledPlugins' | 'disable' | 'enable' | 'disabledPlugins'>;
  enabledDir?: string;
  // The trust record the loader read (a test's own file).
  trust?: TrustOptions;
  // Why each plugin was skipped, by name; a plugin that joins is taken out.
  skipped: Map<string, string>;
  // The enabled plugins not trusted — the start screen's list, the same array.
  untrusted: Untrusted[];
  // Loads one enabled plugin (its manifest checked, its module built or its process
  // started); rejects with why it cannot.
  load?: (name: string) => Promise<Plugin>;
}

// What the App gives the panel: its live list and the ways to change it.
export interface PluginsHost {
  plugins: Plugin[];
  builtins: string[];
  config: Record<string, unknown>;
  keys: Record<string, string[]>;
  site: PluginSite;
  // What is still starting (src/loader/late.ts).
  starting: () => string[];
  // Disabled while the app runs and still loaded: tools out, screens and keys until a
  // restart.
  disabledNow: Set<string>;
  // Takes a plugin's tools out of the registry, or lets them back in, and builds what
  // was built from the list again.
  withhold: (name: string, on: boolean) => void;
  // Takes a plugin out of the list (a remote plugin being restarted).
  unload: (plugin: Plugin) => void;
  // Starts loading an enabled plugin; it joins the list when it is ready, through the
  // same path as a plugin that joins after the first frame.
  join: (name: string) => Promise<void>;
  // Stops a remote plugin's process for good.
  stop: (plugin: Plugin) => Promise<void>;
  notify: () => void;
  log: (line: string) => void;
}

type Snapshot = { entries: Map<string, RepoEntry>; enabled: string[]; disabled: string[] };

const tone = (t: PanelRow['tone']) => (t ? { tone: t } : {});

export function createPluginsPanel(host: PluginsHost) {
  const { plugins, site } = host;
  let snap: Snapshot = { entries: new Map(), enabled: [], disabled: [] };
  // What the repository says now; read on open and after every action, never per draw.
  const refresh = async (): Promise<void> => {
    const repo = site.repo;
    if (!repo) return;
    try {
      const [entries, enabled, disabled] = await Promise.all([repo.list(), repo.enabledPlugins(), repo.disabledPlugins?.() ?? Promise.resolve([])]);
      snap = { entries: new Map(entries.map((e) => [e.name, e])), enabled, disabled };
    } catch (e) {
      host.log(`[plugins] the plugin list cannot be read: ${(e as Error).message}`);
    }
    host.notify();
  };

  const loaded = (name: string) => plugins.find((p) => p.name === name);
  const untrustedOf = (name: string) => site.untrusted.find((u) => u.name === name);
  const isBuiltin = (name: string) => host.builtins.includes(name);

  // Every plugin the panel knows of: the list's own first, in its order, then the rest.
  const names = (): string[] => {
    const out: string[] = [];
    const add = (n: string) => { if (n && !isBuiltin(n) && !out.includes(n)) out.push(n); };
    for (const p of plugins) add(p.name);
    const rest = new Set<string>([...snap.enabled, ...snap.disabled, ...host.starting(), ...site.untrusted.map((u) => u.name), ...site.skipped.keys()]);
    for (const n of [...rest].sort()) add(n);
    return out;
  };

  // What a loaded plugin brings: its tool groups and tools, and its keys as bound now.
  const brings = (p: Plugin): string => {
    const groups = (p.tools ?? []) as Array<{ tools?: unknown[] }>;
    const tools = groups.reduce((n, g) => n + (g.tools?.length ?? 0), 0) + (p.aiTools?.length ?? 0);
    const keys = Object.keys(p.keys ?? {}).map((a) => bindingGlyph(host.keys[a])).filter(Boolean);
    return [
      groups.length ? `${groups.length} group${groups.length === 1 ? '' : 's'}` : '',
      tools ? `${tools} tool${tools === 1 ? '' : 's'}` : '',
      keys.length ? `keys ${keys.join(' ')}` : '',
    ].filter(Boolean).join(' · ');
  };

  // A plugin's state, in the words the row says it.
  const state = (name: string): { text: string; tone?: PanelRow['tone'] } => {
    const p = loaded(name);
    if (p && host.disabledNow.has(name)) return { text: 'disabled (restart to unload)', tone: 'warn' };
    const u = untrustedOf(name);
    if (!p && snap.disabled.includes(name)) return { text: 'disabled' };
    if (u) return { text: u.refused ? untrustedText(u) : u.was && u.now ? `not trusted — its link led to ${u.was}, now to ${u.now}` : 'not trusted — not loaded until you trust it (y)', tone: 'warn' };
    if (host.starting().includes(name)) return { text: 'starting…' };
    if (!p && site.skipped.has(name)) return { text: `skipped: ${site.skipped.get(name)}`, tone: 'error' };
    const missing = snap.entries.get(name)?.missingSettings ?? [];
    if (missing.length) return { text: `missing settings: ${missing.join(', ')}`, tone: 'warn' };
    if (p) return { text: 'active', tone: 'ok' };
    return { text: 'not loaded' };
  };

  const row = (name: string): PanelRow => {
    const p = loaded(name);
    const version = snap.entries.get(name)?.version;
    const s = state(name);
    const extra = p && !host.disabledNow.has(name) ? brings(p) : '';
    return { id: name, text: shownName(name), detail: [version ? `v${version}` : '', s.text, extra].filter(Boolean).join(' · '), ...tone(s.tone) };
  };

  // ── the actions ─────────────────────────────────────────────────────────────
  const disable = async (name: string): Promise<string> => {
    const repo = site.repo;
    if (!repo?.disable) return '⚠ the plugins directory is not known here';
    const res = await repo.disable(name);
    if (!res.ok) return `⚠ ${res.error ?? 'could not disable it'}`;
    // Not trusted and never loaded: nothing to take out, and nothing to trust.
    const at = site.untrusted.findIndex((u) => u.name === name);
    if (at >= 0) site.untrusted.splice(at, 1);
    if (loaded(name) || host.starting().includes(name)) {
      host.disabledNow.add(name);
      host.withhold(name, true);
      await refresh();
      return `${name} disabled — its tools are out from the next step; its screens and keys go at a restart`;
    }
    await refresh();
    return `${name} disabled`;
  };

  const enable = async (name: string): Promise<string> => {
    const repo = site.repo;
    if (!repo?.enable || !site.enabledDir) return '⚠ the plugins directory is not known here';
    const res = await repo.enable(name);
    if (!res.ok) return `⚠ ${res.error ?? 'could not enable it'}`;
    // Disabled in this run and still loaded: its tools come back.
    if (host.disabledNow.has(name)) {
      host.disabledNow.delete(name);
      host.withhold(name, false);
      await refresh();
      return `${name} enabled`;
    }
    // Loaded only when trusted, as at a start — never trusted by enabling it.
    const check = checkPluginTrust(site.enabledDir, [name], { ...site.trust, readOnly: true });
    const u = check.untrusted.find((x) => x.name === name);
    if (u) {
      if (!untrustedOf(name)) site.untrusted.push(u);
      await refresh();
      return `${name} enabled — not loaded until you trust it (y)`;
    }
    site.skipped.delete(name);
    await host.join(name);
    await refresh();
    return `${name} enabled — starting`;
  };

  const restart = async (name: string): Promise<string> => {
    const p = loaded(name);
    if (!p) return `⚠ ${name} is not running`;
    if (!isRemotePlugin(p)) return `⚠ ${name} runs inside the app — restart the app to load it again`;
    if (!site.load) return '⚠ the plugins directory is not known here';
    if (host.disabledNow.has(name)) return `⚠ ${name} is disabled — d enables it`;
    host.unload(p);
    await host.stop(p);
    site.skipped.delete(name);
    await host.join(name);
    return `restarting ${name}`;
  };

  const trust = (name: string, yes = false): string | PanelSpec => {
    if (!site.enabledDir) return '⚠ the plugins directory is not known here';
    const u = untrustedOf(name);
    if (!u) return loaded(name) ? `${name} is trusted` : `⚠ ${name} is not waiting for trust`;
    const res = trustPlugin(site.enabledDir, name, { ...site.trust, yes });
    if (!res.ok && res.confirm) {
      const { was, now } = res.confirm;
      return {
        title: `Trust ${name}?`,
        rows: () => [
          { id: 'was', text: 'its link led to', detail: was },
          { id: 'now', text: 'now it leads to', detail: now, tone: 'warn' as const },
        ],
        keys: [{ key: 'y', label: `trust ${name} at its new place`, run: () => trust(name, true) }],
      };
    }
    if (!res.ok) return `⚠ ${res.error}`;
    const at = site.untrusted.findIndex((x) => x.name === name);
    if (at >= 0) site.untrusted.splice(at, 1);
    host.log(`[plugins] ${name} trusted from the :plugins panel: ${res.target}${res.was ? ` (was ${res.was})` : ''}`);
    if (!loaded(name) && snap.enabled.includes(name) && !host.starting().includes(name)) {
      site.skipped.delete(name);
      void host.join(name).then(refresh);
      return `${name} trusted — starting`;
    }
    void refresh();
    return `${name} trusted`;
  };

  // ── the panels ──────────────────────────────────────────────────────────────
  const toolsPanel = (name: string): PanelSpec => ({
    title: `Plugins · ${name} · tools`,
    empty: 'No tools — it is not running, or brings none.',
    rows: () => {
      const p = loaded(name);
      if (!p) return [];
      const defs = [
        ...((p.tools ?? []) as Array<{ tools?: Array<{ function?: { name?: string; description?: string }; write?: unknown }> }>).flatMap((g) => g.tools ?? []),
        ...((p.aiTools ?? []) as Array<{ function?: { name?: string; description?: string }; write?: unknown }>),
      ];
      return defs.filter((t) => typeof t.function?.name === 'string').map((t) => ({
        id: t.function!.name!,
        text: t.function!.name!,
        detail: `${t.write ? 'asks first · ' : ''}${String(t.function!.description ?? '').replace(/\s+/g, ' ').slice(0, 120)}`,
        ...(t.write ? {} : { tone: 'ok' as const }),
      }));
    },
  });

  // Read once, when it opens: the manifest and the config are on disk and in memory.
  const detailsPanel = (name: string): PanelSpec => {
    const lines: PanelRow[] = [];
    const add = (text: string, detail?: string, t?: PanelRow['tone']) => lines.push({ id: String(lines.length), text, ...(detail ? { detail } : {}), ...tone(t) });
    const entry = snap.entries.get(name);
    const p = loaded(name);
    const manifest = site.enabledDir ? readPluginManifest(join(site.enabledDir, name)) ?? readPluginManifest(join(site.enabledDir, DISABLED_DIR, name)) : null;
    const description = p?.description ?? entry?.description ?? (typeof manifest?.description === 'string' ? manifest.description : '');
    const s = state(name);
    add('state', s.text, s.tone);
    if (description) add('what it is', description);
    if (entry?.version) add('version', `v${entry.version}${entry.source && entry.source !== 'git' ? ` · ${entry.source}` : ''}`);
    const hostApi = manifest?.hostApi;
    add('host API', hostApi === undefined ? '1 (not declared)' : Array.isArray(hostApi) ? hostApi.join(', ') : String(hostApi));
    add('flowtty', typeof manifest?.flowtty === 'string' ? manifest.flowtty : 'not declared');
    if (entry?.incompatible) add('cannot load', entry.incompatible, 'error');
    const why = site.skipped.get(name);
    if (why && !p) add('skipped', why, 'error');
    const u = untrustedOf(name);
    if (u?.was && u.now) { add('trusted at', u.was); add('now leads to', u.now, 'warn'); }
    if (p) { const b = brings(p); if (b) add('brings', b); }
    // Its settings, a secret-looking key masked, and the environment it needs.
    const own = (host.config.plugins as Record<string, unknown> | undefined)?.[name];
    const settings = flattenConfigPaths(own ?? {}, `plugins.${name}`);
    for (const { path, value } of settings) add(path, shownValue(path, value));
    if (!settings.length) add(`plugins.${name}`, 'nothing set');
    const required = Array.isArray(manifest?.requiredSettings) ? (manifest!.requiredSettings as unknown[]).filter((k): k is string => typeof k === 'string') : [];
    for (const k of required) add(k, process.env[k] ? 'set' : 'required — unset', process.env[k] ? 'ok' : 'error');
    return { title: `Plugins · ${name}`, rows: () => lines };
  };

  const spec = (): PanelSpec => {
    void refresh();
    return {
      title: 'Plugins',
      empty: 'No plugins — flow-assist plugins install <name>',
      rows: () => names().map(row),
      keys: [
        { key: 'return', label: 'details', run: (id) => (id ? detailsPanel(id) : '') },
        { key: 'r', label: 'restart', run: (id) => (id ? restart(id) : '') },
        { key: 'd', label: 'disable / enable', run: (id) => {
          if (!id) return '';
          const off = (host.disabledNow.has(id) && !!loaded(id)) || (!loaded(id) && snap.disabled.includes(id));
          return off ? enable(id) : disable(id);
        } },
        { key: 't', label: 'tools', run: (id) => (id ? toolsPanel(id) : '') },
        { key: 'y', label: 'trust', run: (id) => (id ? trust(id) : '') },
      ],
    };
  };

  return { spec, refresh, rows: () => names().map(row) };
}
