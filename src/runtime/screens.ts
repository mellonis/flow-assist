// Screens a plugin declares, and the one set of rules the host opens them by
// (docs/plugins.md, "Screens the model can open").
//
// A plugin names its screens in its shape (`screens`): the entry screen — what its entry
// key leads to — and any other, each with the params it takes and a function that puts
// it up. The function lives in the shape, not in a component, so a screen opens whether
// or not the plugin's surface was ever mounted: it sets the plugin's own state, the
// plugin's `keycaps` say its context is active, and the host mounts the surface.
//
// A remote plugin's entry is declared for it by the adapter (src/remote/adapter.ts): its
// `open` sends the key event the entry key would.
//
// Who opens: a plugin (`host.open(screen, params)` — a navigation tool of its own), and
// the model (`ui_open(plugin)`, the core tool, an entry screen with no params). The
// rules hold for both:
// - only a screen a loaded plugin declared, of a plugin the person trusts and has not
//   disabled — never one of the host's own panels (`:plugins`, `/mcp`, the session
//   picker, settings, the help, the log), which are the person's to open;
// - never over the person's typing — the chat's field holding a draft, the `:` line open
//   — or over a y/n or question waiting for them: the open waits for the turn's end
//   (for the chat to be free, outside a turn), and the answer says so at once — a tool
//   that awaited the turn it runs in would wait forever;
// - a turn the person stopped, or one that failed, opens nothing it deferred;
// - a screen is its session's: a session the person left opens none, and one it
//   deferred before it was left is dropped;
// - the answer is always a sentence a tool can hand back as it is.
// Esc closes a screen as it closes any: the plugin's own key. `host.close(screen)` asks
// the plugin to close one, when it declared how.
import type { Plugin } from '../loader/plugin.js';
import type { Untrusted } from '../loader/trust.js';
import { bindingGlyph } from '../playback/keys.js';
import { toolArgsError } from '../assistant/tool-args.js';
import { sanitizeGroupDescription } from '../assistant/tool-loading.js';
import { cutStep } from '../cells.js';
import { inBackgroundWork, inUnattachedWork, workOwner, type WorkOwner } from './background-work.js';

// One screen as a plugin declares it.
export interface ScreenDecl {
  // The screen the plugin's entry key leads to — the one `ui_open` opens.
  entry?: boolean;
  // What the screen shows, in a few words, for the model's list (`board`, `an issue`).
  title?: string;
  // The params it takes, as JSON Schema — a tool's `parameters` shape. None: it takes none.
  params?: Record<string, unknown>;
  // The plugin's own tools that open it — its navigation, named in the model's list in
  // `ui_open`'s place.
  tools?: string[];
  // Puts the screen up: the plugin sets its own state. May return what was opened, in a
  // few words (`board FRONT`), or `ALREADY_OPEN` when it was up and nothing was done; a
  // throw is the reason it was not.
  open: (api: unknown, params: Record<string, unknown>) => unknown;
  // Takes it down; without it the host cannot close the screen (Esc still does).
  close?: (api: unknown) => unknown;
}

// What a screen's `open` returns when the screen is up already and it did nothing.
export const ALREADY_OPEN = Symbol.for('flow-assist.screen.already-open');

// What `open` and `close` answer. `text` is a sentence for the model or the person, in
// every case; `deferred` — accepted, and opened when the chat is free.
export interface ScreenResult {
  ok: boolean;
  text: string;
  screen?: string;
  deferred?: boolean;
  opened?: string;
}

// The host's own panels, by the names a model or a plugin might try: never openable.
export const HOST_PANELS = ['plugins', 'mcp', 'sessions', 'session', 'settings', 'config', 'help', 'log', 'chat', 'context', 'trust'];

const isDecl = (v: unknown): v is ScreenDecl => !!v && typeof v === 'object' && typeof (v as ScreenDecl).open === 'function';

// A plugin's declared screens, the malformed ones left out.
export function screensOf(p: Pick<Plugin, 'screens'>): Array<[string, ScreenDecl]> {
  const s = p.screens;
  if (!s || typeof s !== 'object') return [];
  return Object.entries(s).filter((e): e is [string, ScreenDecl] => isDecl(e[1]));
}

// The screen `ui_open` opens: the one marked `entry`, else the only one declared.
export function entryScreen(p: Pick<Plugin, 'screens'>): [string, ScreenDecl] | null {
  const all = screensOf(p);
  return all.find(([, d]) => d.entry) ?? (all.length === 1 ? all[0]! : null);
}

// A plugin's words, as the model's list and a result may carry them: one line, no
// control characters or frame words, and short.
const said = (raw: unknown, max = 120): string => cutStep(sanitizeGroupDescription(String(raw ?? '')).replace(/\s+/g, ' ').trim(), max);

export interface ScreensDeps {
  plugins: Plugin[];
  builtins: string[];
  // Disabled from the `:plugins` panel while the app runs.
  disabled: ReadonlySet<string>;
  untrusted: () => Untrusted[];
  starting: () => string[];
  keys: Record<string, string[]>;
  // The pair a plugin's hooks get; undefined until the App built it.
  apiOf: (name: string) => unknown;
  // The chat, as the App reads it: whether a turn runs, what holds a screen back now
  // (null — nothing), whether an open chat covers the plugin's side.
  busy: () => boolean;
  blocker: () => string | null;
  asking: () => boolean;
  covered: () => boolean;
  notify: () => void;
  log: (line: string) => void;
  // A deferred open that failed once it ran: said to the person (a toast).
  say: (line: string) => void;
}

export interface Screens {
  open: (from: string | null, screen: string, params?: unknown) => Promise<ScreenResult>;
  close: (from: string | null, screen: string) => Promise<ScreenResult>;
  // The model's `ui_open`: a plugin's entry screen, by the plugin's name.
  uiOpen: (name: string) => Promise<ScreenResult>;
  // The chat is free: a turn ended (`ended`, `ok` false when it was stopped or failed),
  // or nothing holds a screen back any more.
  afterTurn: (ok: boolean) => void;
  settle: () => void;
  pending: () => string[];
  // `owner` was left: what its work deferred is dropped.
  dropFor: (owner: object) => void;
  // The system prompt's `## Screens` block; '' with nothing to list.
  promptBlock: () => string;
}

// What one plugin's line lists at most of its screens and of its tools, and how long the
// whole block may be.
const LINE_ITEMS_MAX = 8;
const PROMPT_BLOCK_MAX = 4000;
const capped = (items: string[]): string => (items.length > LINE_ITEMS_MAX ? `${items.slice(0, LINE_ITEMS_MAX).join(', ')}, +${items.length - LINE_ITEMS_MAX} more` : items.join(', '));

type Resolved = { plugin: Plugin; name: string; decl: ScreenDecl; key: string };

export function createScreens(d: ScreensDeps): Screens {
  // `owner`: whose work deferred it (src/runtime/background-work.ts); undefined for an
  // open nobody's turn made — a plugin's own key.
  const deferred: Array<{ r: Resolved; params: Record<string, unknown>; owner: WorkOwner | undefined }> = [];
  const builtin = (name: string) => d.builtins.includes(name);
  const usable = (p: Plugin) => !builtin(p.name) && !d.disabled.has(p.name) && !d.untrusted().some((u) => u.name === p.name);

  // Why a plugin's screens cannot be opened now; null — they can.
  const pluginRefusal = (name: string): string | null => {
    if (!name) return 'no screen named — give the plugin\'s name';
    if (builtin(name) || HOST_PANELS.includes(name.toLowerCase())) return `${said(name, 40)} is the host's own — only the person opens it`;
    if (d.disabled.has(name)) return `${said(name, 40)} was disabled by the person`;
    if (d.untrusted().some((u) => u.name === name)) return `${said(name, 40)} is not trusted — only the person decides that`;
    if (!d.plugins.some((p) => p.name === name)) {
      if (d.starting().includes(name)) return `${said(name, 40)} is still starting — try again in a moment`;
      return `no plugin ${said(name, 40)} is loaded`;
    }
    if (!d.apiOf(name)) return `${said(name, 40)} is still starting — try again in a moment`;
    return null;
  };

  const resolve = (from: string | null, screen: string): Resolved | string => {
    const raw = String(screen ?? '').trim();
    const at = raw.indexOf(':');
    const pluginName = at > 0 ? raw.slice(0, at) : from;
    const name = at > 0 ? raw.slice(at + 1) : raw;
    if (!pluginName) return 'name the plugin as well: <plugin>:<screen>';
    const no = pluginRefusal(pluginName);
    if (no) return no;
    const plugin = d.plugins.find((p) => p.name === pluginName)!;
    const all = screensOf(plugin);
    const decl = all.find(([n]) => n === name)?.[1];
    if (!decl) {
      return all.length
        ? `${pluginName} has no screen ${said(name, 40) || '""'} — its screens: ${all.map(([n]) => n).join(', ')}`
        : `${pluginName} declares no screen the host can open`;
    }
    return { plugin, name, decl, key: `${pluginName}:${name}` };
  };

  const run = async (r: Resolved, params: Record<string, unknown>): Promise<ScreenResult> => {
    let label = '';
    try {
      const out = await r.decl.open(d.apiOf(r.plugin.name), params);
      if (out === ALREADY_OPEN) return { ok: true, screen: r.key, opened: r.key, text: `${r.key} is already open.` };
      if (typeof out === 'string') label = said(out);
    } catch (e) {
      return { ok: false, screen: r.key, text: `${r.key} was not opened: ${said(e instanceof Error ? e.message : e, 200)}` };
    }
    d.notify();
    const behind = d.covered() ? ' It is behind the chat: the person sees it when the chat is closed.' : '';
    return { ok: true, screen: r.key, opened: label || r.key, text: `Opened ${r.key}${label ? ` — ${label}` : ''}.${behind}` };
  };

  const open = async (from: string | null, screen: string, paramsIn?: unknown): Promise<ScreenResult> => {
    // A background task runs apart from the screen: whatever it calls opens nothing.
    if (inBackgroundWork()) return { ok: false, text: 'Not opened: screens are not opened from background work.' };
    // A session nobody draws opens nothing over the one on screen.
    if (inUnattachedWork()) return { ok: false, text: 'Not opened: this session is not on screen — the person is in another one.' };
    const r = resolve(from, screen);
    if (typeof r === 'string') return { ok: false, text: `Not opened: ${r}.` };
    if (paramsIn != null && (typeof paramsIn !== 'object' || Array.isArray(paramsIn))) return { ok: false, screen: r.key, text: `Not opened: ${r.key}'s params are an object.` };
    const params = (paramsIn ?? {}) as Record<string, unknown>;
    if (r.decl.params) {
      const bad = toolArgsError(r.key, r.decl.params as never, params);
      if (bad) return { ok: false, screen: r.key, text: `Not opened: ${bad}` };
    } else if (Object.keys(params).length) {
      return { ok: false, screen: r.key, text: `Not opened: ${r.key} takes no params.` };
    }
    const why = d.blocker();
    if (why) {
      const at = deferred.findIndex((x) => x.r.key === r.key);
      if (at >= 0) deferred.splice(at, 1);
      deferred.push({ r, params, owner: workOwner() });
      const when = d.busy() ? 'when this turn ends' : 'once the chat is free';
      d.log(`[screens] ${r.key} waits — ${why}`);
      return { ok: true, deferred: true, screen: r.key, text: `${r.key} is not open yet: ${why}. It opens ${when}.` };
    }
    return run(r, params);
  };

  // A deferred open is checked again when it runs: the plugin may have been disabled,
  // lost the person's trust or left the list while it waited.
  const flush = (ok: boolean) => {
    if (!deferred.length) return;
    const due = deferred.splice(0, deferred.length);
    for (const { r: was, params } of due) {
      if (!ok) { d.log(`[screens] ${was.key} not opened — the turn was stopped`); continue; }
      const r = resolve(null, was.key);
      const bad = typeof r === 'string' ? r : r.decl.params ? toolArgsError(r.key, r.decl.params as never, params) : null;
      if (bad || typeof r === 'string') {
        const text = `${was.key} was not opened: ${bad}`;
        d.log(`[screens] ${text}`);
        d.say(text);
        continue;
      }
      void run(r, params).then((res) => {
        d.log(`[screens] ${res.text}`);
        if (!res.ok) d.say(res.text);
      });
    }
  };

  return {
    open,
    close: async (from, screen) => {
      const r = resolve(from, screen);
      if (typeof r === 'string') return { ok: false, text: `Not closed: ${r}.` };
      const at = deferred.findIndex((x) => x.r.key === r.key);
      if (at >= 0) deferred.splice(at, 1);
      if (!r.decl.close) return { ok: false, screen: r.key, text: `Not closed: ${r.key} cannot be closed by the host — Esc closes it.` };
      try {
        await r.decl.close(d.apiOf(r.plugin.name));
      } catch (e) {
        return { ok: false, screen: r.key, text: `${r.key} was not closed: ${said(e instanceof Error ? e.message : e, 200)}` };
      }
      d.notify();
      return { ok: true, screen: r.key, text: `Closed ${r.key}.` };
    },
    uiOpen: async (nameIn) => {
      const raw = String(nameIn ?? '').trim();
      const at = raw.indexOf(':');
      const pluginName = at > 0 ? raw.slice(0, at) : raw;
      const no = pluginRefusal(pluginName);
      if (no) return { ok: false, text: `Not opened: ${no}.` };
      const plugin = d.plugins.find((p) => p.name === pluginName)!;
      const entry = entryScreen(plugin);
      const tools = [...new Set(screensOf(plugin).flatMap(([, s]) => s.tools ?? []))];
      const own = tools.length ? ` — its screens open with its own tools: ${tools.join(', ')}` : '';
      if (!entry) return { ok: false, text: `Not opened: ${pluginName} has no screen ui_open can open${own || ' — the person opens it with its key'}.` };
      if (at > 0 && raw.slice(at + 1) !== entry[0]) return { ok: false, text: `Not opened: ui_open opens ${pluginName}'s entry screen (${entry[0]})${own}.` };
      const required = (entry[1].params as { required?: unknown } | undefined)?.required;
      if (Array.isArray(required) && required.length) return { ok: false, text: `Not opened: ${pluginName}'s entry screen needs ${required.join(', ')}${own}.` };
      return open(null, `${pluginName}:${entry[0]}`, {});
    },
    afterTurn: (ok) => {
      // A stopped or failed turn drops what it deferred first, whatever still waits for
      // the person (a settings y/n asked as the turn ends).
      if (!ok) { flush(false); return; }
      if (d.asking()) return;
      flush(true);
    },
    settle: () => {
      if (!deferred.length || d.busy() || d.blocker()) return;
      flush(true);
    },
    pending: () => deferred.map((x) => x.r.key),
    dropFor: (owner) => {
      for (const x of deferred.filter((e) => e.owner === owner)) {
        deferred.splice(deferred.indexOf(x), 1);
        d.log(`[screens] ${x.r.key} not opened — its session was left`);
      }
    },
    promptBlock: () => {
      const lines: string[] = [];
      for (const p of d.plugins) {
        if (!usable(p)) continue;
        const all = screensOf(p);
        const entry = entryScreen(p);
        const keys = (p.entry ?? []).map((a) => bindingGlyph(d.keys[a])).filter(Boolean);
        if (!all.length && !keys.length) continue;
        const what = all.length ? capped(all.map(([n, s]) => said(s.title ?? n, 40))) : said(p.description ?? '', 80);
        const tools = [...new Set(all.flatMap(([, s]) => s.tools ?? []))].map((t) => said(t, 60));
        const entryOwn = !!entry?.[1].tools?.length;
        const how = [...(entry && !entryOwn ? [`ui_open("${p.name}")`] : []), ...tools];
        const parts = [what, keys.length ? `key ${keys.join(' / ')}` : '', how.length ? `open with ${capped(how)}` : 'the person opens it with its key'].filter(Boolean);
        lines.push(`- ${p.name} — ${parts.join(' · ')}`);
      }
      if (!lines.length) return '';
      // The block rides on every request: past its size the rest of the plugins are
      // counted, not listed.
      let size = 0;
      const kept = lines.filter((l) => (size += l.length + 1) <= PROMPT_BLOCK_MAX);
      if (kept.length < lines.length) kept.push(`- +${lines.length - kept.length} more plugins`);
      return [
        '## Screens',
        'The plugins\' screens the person can see, one line each: what they show, the key the person presses, and how you open one. Open a screen when the person asks to see it. The host\'s own panels (:plugins, /mcp, the sessions, settings) are the person\'s to open, never yours.',
        ...kept,
      ].join('\n');
    },
  };
}
