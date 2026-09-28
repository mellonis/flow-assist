// `:plugins` — the plugins and what the person can do to them, as `/mcp` is for servers.
// The runtime's, not the chat's: it works with the chat closed and without the assistant
// plugin at all, which is what makes it the place to fix a broken plugin. `/plugins` in
// the chat opens the same panel in the chat's frame (the command is `chat: true`); the
// chat only draws it.
//
// One row per plugin — enabled, disabled, starting, skipped, not trusted — with its
// version, its state and what it brings (tool groups, tools, keys). The keys:
//   ⏎  details — what it is, the ranges it declares, why it was skipped, where its link
//      leads, its settings
//   r  restart — a remote plugin's process stopped and started again, through the same
//      path a plugin that joins after the first frame takes
//   d  disable / enable — its link moved to `plugins-enabled/.disabled/` and back; a
//      disable forgets the trust, and enabling never gives it back
//   t  tools — its tools, the ones that ask first marked
//   y  trust — the person's word, as `flow-assist plugins trust` gives it: a first trust
//      shows where the link leads and a link that moved shows both places, each asking
//      for a second `y`; a plugin a disable forgot, leading where it did, at once
// Installing, removing and updating stay the CLI's and the model's tools; the panel shows
// what they did once it is opened again.
//
// Trust is the person's alone: the `y` here is a key pressed in this panel. Nothing the
// model can call reaches it — no tool, no line typed into the chat's queue, no request a
// remote plugin can make. Every plugin the panel loads (enable, restart, trust) goes
// through `site.load`, which checks the trust again and loads from where it was trusted.
//
// `rows()` is read at every draw and every second, so it reads no disk: what the
// repository and the trust record say (versions, missing settings, what is disabled,
// where each link leads) is read when the panel opens and after each action; what
// changes on its own (starting, joined, skipped) is read live from the App.
import type { Plugin } from '../loader/plugin.js';
import type { PluginRepo, RepoEntry } from '../loader/repo.js';
import { DISABLED_DIR, isTrustedNow, pluginTrustOf, shownName, trustPlugin, untrustedOf as untrustedFrom, untrustedText, type PluginTrustState, type TrustOptions, type Untrusted } from '../loader/trust.js';
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
  // Loads one enabled plugin — its trust checked first and loaded from where it was
  // trusted (`loadTrustedPlugin`), its module built or its process started; rejects with
  // why it cannot (`UntrustedPluginError` when it is not trusted now).
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
  // Takes a plugin out of the list (a remote plugin being restarted); `why` is what a
  // call to one of its tools meanwhile is told (`is restarting`).
  unload: (plugin: Plugin, why?: string) => void;
  // Starts loading an enabled plugin; it joins the list when it is ready, through the
  // same path as a plugin that joins after the first frame.
  join: (name: string) => Promise<void>;
  // Stops a remote plugin's process for good.
  stop: (plugin: Plugin) => Promise<void>;
  notify: () => void;
  log: (line: string) => void;
}

// `trust` — where each enabled or disabled plugin's link leads and what the trust record
// says of it, read with the rest.
type Snapshot = { entries: Map<string, RepoEntry>; enabled: string[]; disabled: string[]; trust: Map<string, PluginTrustState> };

const tone = (t: PanelRow['tone']) => (t ? { tone: t } : {});

export function createPluginsPanel(host: PluginsHost) {
  const { plugins, site } = host;
  let snap: Snapshot = { entries: new Map(), enabled: [], disabled: [], trust: new Map() };
  // What the repository says now; read on open and after every action, never per draw.
  const refresh = async (): Promise<void> => {
    const repo = site.repo;
    if (!repo) return;
    try {
      const [entries, enabled, disabled] = await Promise.all([repo.list(), repo.enabledPlugins(), repo.disabledPlugins?.() ?? Promise.resolve([])]);
      const dir = site.enabledDir;
      const trust = new Map(dir ? [...enabled, ...disabled].map((n) => [n, pluginTrustOf(dir, n, site.trust)] as const) : []);
      snap = { entries: new Map(entries.map((e) => [e.name, e])), enabled, disabled, trust };
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
    if (u) {
      if (u.refused) return { text: untrustedText(u), tone: 'warn' };
      if (u.was && u.now) return { text: `not trusted — its link led to ${u.was}, now to ${u.now} (y)`, tone: 'warn' };
      const now = snap.trust.get(name)?.target;
      return { text: now ? `not trusted — its link leads to ${now} (y)` : 'not trusted (y)', tone: 'warn' };
    }
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
    const nm = shownName(name);
    const repo = site.repo;
    if (!repo?.disable) return '⚠ the plugins directory is not known here';
    // The repository forgets its trust with it (./trust.ts): enabling it again waits for `y`.
    const res = await repo.disable(name);
    if (!res.ok) return `⚠ ${res.error ?? `${nm} could not be disabled`}`;
    const at = site.untrusted.findIndex((u) => u.name === name);
    if (at >= 0) site.untrusted.splice(at, 1);
    if (loaded(name) || host.starting().includes(name)) {
      host.disabledNow.add(name);
      host.withhold(name, true);
      await refresh();
      return `${nm} disabled — its tools are out from the next step; its screens and keys go at a restart`;
    }
    await refresh();
    return `${nm} disabled`;
  };

  // Enabling never trusts: a disable forgot the trust, and a plugin not trusted before
  // it was disabled is not trusted now. The row asks for `y`.
  const enable = async (name: string): Promise<string> => {
    const nm = shownName(name);
    const repo = site.repo;
    if (!repo?.enable || !site.enabledDir) return '⚠ the plugins directory is not known here';
    const res = await repo.enable(name);
    if (!res.ok) return `⚠ ${res.error ?? `${nm} could not be enabled`}`;
    // Disabled in this run and still loaded: its tools stay out until it is trusted.
    host.disabledNow.delete(name);
    const state = pluginTrustOf(site.enabledDir, name, site.trust);
    if (isTrustedNow(state)) {
      if (loaded(name)) host.withhold(name, false);
      else { site.skipped.delete(name); await host.join(name); }
      await refresh();
      return `${nm} enabled`;
    }
    const u = untrustedFrom(state);
    const at = site.untrusted.findIndex((x) => x.name === name);
    if (at >= 0) site.untrusted.splice(at, 1, u); else site.untrusted.push(u);
    await refresh();
    return `${nm} enabled — not trusted: y trusts it, then it ${loaded(name) ? 'gets its tools back' : 'loads'}`;
  };

  const restart = async (name: string): Promise<string> => {
    const nm = shownName(name);
    const p = loaded(name);
    if (!p) return `⚠ ${nm} is not running`;
    if (!isRemotePlugin(p)) return `⚠ ${nm} runs inside the app — restart the app to load it again`;
    if (!site.load) return '⚠ the plugins directory is not known here';
    if (host.disabledNow.has(name)) return `⚠ ${nm} is disabled — d enables it`;
    // Loaded again through the one guarded path (`site.load`): a link that no longer leads
    // where it was trusted loads nothing, and the row says where it led and leads.
    host.unload(p, 'is restarting');
    await host.stop(p);
    site.skipped.delete(name);
    await host.join(name);
    return `restarting ${nm}`;
  };

  // The person's word, as `flow-assist plugins trust` gives it — never on one keypress
  // for a place they have not seen: a first trust shows where the link leads, a link that
  // leads elsewhere than it did shows both, and each waits for its own `y`. A plugin whose
  // trust a disable forgot, leading where it did, is trusted again at once.
  const trust = (name: string, shown?: string): string | PanelSpec => {
    const nm = shownName(name);
    if (!site.enabledDir) return '⚠ the plugins directory is not known here';
    if (!untrustedOf(name)) return loaded(name) ? `${nm} is trusted` : `⚠ ${nm} is not waiting for trust`;
    const state = pluginTrustOf(site.enabledDir, name, site.trust);
    if (!state.target) return `⚠ ${nm} is not enabled, or its link leads nowhere — d enables it`;
    const was = state.recorded ?? state.forgotten;
    // Asked when the person has not seen this place yet — or it moved since they did.
    if (was !== state.target && shown !== state.target) {
      const now = state.target;
      return {
        title: `Trust ${nm}?`,
        rows: () => (was
          ? [{ id: 'was', text: 'its link led to', detail: was }, { id: 'now', text: 'now it leads to', detail: now, tone: 'warn' as const }]
          : [{ id: 'now', text: 'its link leads to', detail: now, tone: 'warn' as const }, { id: 'rights', text: 'it runs with', detail: "the app's rights" }]),
        keys: [{ key: 'y', label: was ? `trust ${nm} at its new place` : `trust ${nm}`, run: () => trust(name, now) }],
      };
    }
    const res = trustPlugin(site.enabledDir, name, { ...site.trust, yes: true });
    if (!res.ok) return `⚠ ${res.error}`;
    const at = site.untrusted.findIndex((x) => x.name === name);
    if (at >= 0) site.untrusted.splice(at, 1);
    host.log(`[plugins] ${nm} trusted from the :plugins panel: ${res.target}${res.was ? ` (was ${res.was})` : ''}`);
    if (loaded(name)) {
      host.withhold(name, false);
      void refresh();
      return `${nm} trusted — its tools are back`;
    }
    if (!host.starting().includes(name)) {
      site.skipped.delete(name);
      void host.join(name).then(refresh);
      return `${nm} trusted — starting`;
    }
    void refresh();
    return `${nm} trusted`;
  };

  // ── the panels ──────────────────────────────────────────────────────────────
  const toolsPanel = (name: string): PanelSpec => ({
    title: `Plugins · ${shownName(name)} · tools`,
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
    else { const target = snap.trust.get(name)?.target; if (target) add('its link leads to', target, u ? 'warn' : undefined); }
    if (p) { const b = brings(p); if (b) add('brings', b); }
    // Its settings, a secret-looking key masked, and the environment it needs.
    const own = (host.config.plugins as Record<string, unknown> | undefined)?.[name];
    const settings = flattenConfigPaths(own ?? {}, `plugins.${name}`);
    for (const { path, value } of settings) add(path, shownValue(path, value));
    if (!settings.length) add(`plugins.${name}`, 'nothing set');
    const required = Array.isArray(manifest?.requiredSettings) ? (manifest!.requiredSettings as unknown[]).filter((k): k is string => typeof k === 'string') : [];
    for (const k of required) add(k, process.env[k] ? 'set' : 'required — unset', process.env[k] ? 'ok' : 'error');
    return { title: `Plugins · ${shownName(name)}`, rows: () => lines };
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
