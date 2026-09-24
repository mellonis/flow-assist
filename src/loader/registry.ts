// Plugin registry. Pure factory + helper builders over the plugin shape. The
// host is tracker-agnostic: registry keys are namespaced on load — surfaces are
// stored as '<plugin.name>:<surface>' and command names are prefixed with
// '<plugin.name>:<name>', so plugins never collide with the host's base command
// set. Key bindings are merged BY ACTION NAME (not namespaced).

import { z } from 'zod';
import { HOST_DEFAULT_KEYS, bindingGlyph, canonicalBinding, isKey } from '../playback/keys.js';
import { hostConfigSchema } from '../config/schema.js';
import { BASE_COMMANDS, helpText } from '../config/commands.js';
import type { Command as BaseCommand } from '../config/commands.js';
import { makeFactory } from './plugin.js';
import type { Command, Make, MakeFactoryConfig, Plugin, PluginShape } from './plugin.js';
import { renderConsole } from '../assistant/console-view.js';
import type { ViewRenderer, ViewRenderers } from '../assistant/views.js';

// ─── Input types ────────────────────────────────────────────────────────────
// `ui` is the host's input state — the fields the trigger gate cares about.
// `overlay` names the plugin surface currently shown as a favored overlay (e.g.
// a tracker's detail view): while set, the input race must give that surface the
// key (see detailPriority). Generic — any plugin may open an overlay via the
// host's `setOverlay` service; the value is plugin-defined.
type UiState = { cmdOpen?: boolean; modalActive?: boolean; overlay?: string };
// A keyboard event (flowtty reports a `name` plus raw fields).
type InputKey = { name?: string; [k: string]: unknown };
// A resolved input handler — the shape flowtty's `useInputHandler` receives.
type InputEntry = {
  mode: string;
  priority?: (ui: UiState) => number;
  handler: (key: InputKey, ui: UiState) => unknown;
  // This handler asks for the mouse buttons as well, which are otherwise dropped
  // before every handler (`twoPhaseDispatch`, runtime/app.tsx).
  mouse?: boolean;
};
// A registry entry: either the resolved handler, or a lazy `{ get }` wrapper
// (the runtime stores handlers behind `get: () => ref.current`).
type LazyInputEntry = InputEntry | { get: () => InputEntry };

// Adds a plugin to a list (convenient for composition/tests).
export function registerPlugin<T>(list: T[], plugin: T): T[] {
  return [...list, plugin];
}

// Builds the command registry: base metadata from `base` (the host's generic
// command set) plus each plugin's commands. The host namespaces EACH plugin
// command with '<plugin.name>:<name>' so it never collides with the unprefixed
// host/base commands; host/base commands stay as-is. A later plugin wins over an
// earlier one for the same (namespaced) command name.
export function buildCommandRegistry(plugins: PluginShape[] = [], base: Command[] = BASE_COMMANDS): Command[] {
  const byName = new Map<string, Command>();
  for (const c of base) byName.set(c.name, { ...c });
  for (const p of plugins) {
    for (const c of p.commands ?? []) {
      const merged = { ...c, name: `${p.name}:${c.name}` } as Command;
      const prev = byName.get(merged.name) ?? {};
      byName.set(merged.name, { ...prev, ...merged } as Command);
    }
  }
  return [...byName.values()];
}

// Looks up a command by name or alias (case-insensitive). Exact name/alias match
// wins first (the host base commands stay reachable by their bare names). A plugin
// command typed WITHOUT its namespace — e.g. `:ask` for `assistant:ask`,
// `:open` for `tracker:open` — is then matched by the part of the name after the
// plugin prefix and by its aliases, so `:ask` and `:chat` both find
// `assistant:ask`. Only namespaced commands participate: the host base has no ':'
// in its names, and the exact pass above already settled them.
export function findIn(registry: Command[], name: string): Command | null {
  const n = String(name ?? '').toLowerCase();
  const exact = registry.find(c => c.name === n || (c.aliases ?? []).includes(n));
  if (exact) return exact;
  return registry.find(c => {
    const i = c.name.indexOf(':');
    if (i === -1) return false;
    const bare = c.name.slice(i + 1);
    return bare === n || (c.aliases ?? []).includes(n);
  }) ?? null;
}

// Builds the command ctx to hand a plugin command's `run(ctx, arg)`.
//
// A plugin command is namespaced (`tracker:open`), and its `run` body is a thin
// forward into a plugin-specific ctx (the tracker's TrackerCommandCtx). The
// base `ctx` carries only host-owned closures (showMessage/setView/back/…), so a
// plugin command that forwards to one of its own services would find no such
// method and silently no-op. Here we extend the base ctx with the OWNING
// plugin's own-key services (the per-plugin `host.services` the plugin's own
// mount mutates). The host stays agnostic — it never names a plugin method; it
// just spreads them.
//
// Precedence: base ctx wins over plugin services (`...services, ...baseCtx`), so
// a plugin's no-op `showMessage` never shadows the host's real toast. A base
// command (no ':') or a plugin not mounted yet gets the base ctx unchanged.
export function commandContextFor(
  cmd: Command,
  baseCtx: Record<string, unknown>,
  apiMap: Record<string, { host?: { services?: Record<string, unknown> } }> = {},
): Record<string, unknown> {
  const pluginName = cmd.name.includes(':') ? cmd.name.split(':')[0] : null;
  const services = pluginName ? apiMap[pluginName]?.host?.services : undefined;
  return services ? { ...services, ...baseCtx } : baseCtx;
}

// Help text for a registry (sort + usage + description), reusing the shared
// `helpText` helper which accepts any command array.
export function helpFor(registry: Command[]): string {
  return helpText(registry as BaseCommand[]);
}

// The host footer composition (spec: plugin footer hints + universal openBrowser).
// The footer = host base (`: commands`, and `quit` only if config binds it to a
// key — by default it is the `:quit` command; derived from `keys` so a user remap is
// respected) + each plugin's non-empty `keycaps({ ui, host })`. A plugin's `keycaps` returns
// `[]` when its surface is inactive, so an empty screen collapses to `: commands`. `x flush cache` joins only when a plugin
// context is active (content present). `apiMap[plugin.name]` is each plugin's
// runtime (from the App's overlayComps), which `keycaps` reads for live state;
// a plugin whose pair is not built yet (or that declares no keycaps) simply
// contributes nothing. Pure — no imports beyond the plugin shape.
// Is a plugin that keeps data in the cache on screen right now? One answer for the
// footer's `x flush cache` hint AND for the key itself: a key acts where it is shown
// and nowhere else. (`x` used to flush the cache from the start screen too, where
// nothing said it would.)
export function cacheInPlay(plugins: PluginShape[] = [], apiMap: Record<string, unknown> = {}): boolean {
  return plugins.some((p) => {
    const kc = (p as Plugin).keycaps;
    const api = apiMap[p.name];
    return (p as Plugin).usesCache !== false && !!kc && !!api && kc(api).length > 0;
  });
}

export function composeFooterHints(
  plugins: PluginShape[] = [],
  apiMap: Record<string, unknown> = {},
  keys: Record<string, string[]> = {},
): string[] {
  // Bindings are drawn as CAPS (`bindingGlyph`), and an unbound action (config can
  // set `[]`) gets no hint at all — it used to fall back to the default letter and so
  // advertise a key that did nothing.
  const hint = (action: string, label: string): string[] => {
    const cap = bindingGlyph(keys[action]);
    return cap ? [`${cap} ${label}`] : [];
  };
  const hints: string[] = [...hint('commandLine', 'commands'), ...hint('quit', 'quit')];
  const shown = plugins
    .map((p) => {
      const kc = (p as Plugin).keycaps;
      const api = apiMap[p.name];
      return { caches: (p as Plugin).usesCache !== false, hints: kc && api ? kc(api) : [] };
    })
    .filter((s) => s.hints.length);
  // "flush cache" is offered only while a plugin that keeps something in the cache
  // is on screen — the chat's own hint must not advertise a cache it never fills.
  if (cacheInPlay(plugins, apiMap)) hints.push(...hint('clearCache', 'flush cache'));
  return [...hints, ...shown.flatMap((s) => s.hints)];
}

// Merges hotkeys by directive Model B: the host base (HOST_DEFAULT_KEYS) + each
// plugin's `keys`; on top, the plugin namespace `config.plugins.<name>.keys`,
// and above all a global `config.keys` (legacy override). Returns a map of
// { action: [key names] } like resolveKeys. Config beats default: `[]` (an empty
// array) disables an action (isKey([], name) is always false). `keyActions`
// remains the legacy alias for `keys`.
type KeysConfig = {
  plugins?: Record<string, { keys?: Record<string, string | string[]> }>;
  keys?: Record<string, string | string[]>;
};
// The actions the App takes in its `useInput` before any handler (src/runtime/app.tsx):
// Ctrl+] and the chat's collapse key. Bound to a key that types — a letter, Enter,
// Space — they would take it from every field on screen, the chat's, a plugin's and
// the `:` line's alike, and nothing typed could undo it. So they take only a chord:
// Ctrl or Alt held, an F-key, or a control byte (0x1c–0x1f read as Ctrl, which
// `canonicalBinding` already spells `ctrl+…`). Unbound (`[]`) is fine too.
export const APP_TAKEN_ACTIONS: readonly string[] = ['chatFocus', 'chatCollapse'];
export const isChordKey = (id: string): boolean =>
  id.startsWith('ctrl+') || id.startsWith('alt+') || /^(shift\+)?f([1-9]|1\d|2[0-4])$/.test(id);

// `warn` hears one line per such action whose binding was refused (the App puts it in
// the log); a caller that only reads the bindings leaves it out.
export function buildKeys(
  plugins: PluginShape[] = [],
  config: KeysConfig = {},
  base: Record<string, string | string[]> = HOST_DEFAULT_KEYS,
  warn?: (line: string) => void,
): Record<string, string[]> {
  const merged: Record<string, string | string[]> = { ...base };
  // What each plugin itself binds an action to, before any config.
  const defaults: Record<string, string | string[]> = { ...base };
  for (const p of plugins) {
    const pk = p.keys ?? p.keyActions ?? {};
    const pKeys = config?.plugins?.[p.name]?.keys;
    for (const [action, binding] of Object.entries(pk)) {
      merged[action] = pKeys?.[action] ?? binding;
      defaults[action] = binding;
    }
  }
  const out: Record<string, string[]> = {};
  for (const [action, def] of Object.entries(merged)) {
    out[action] = canonicalBinding(config?.keys?.[action] ?? def);
    if (APP_TAKEN_ACTIONS.includes(action) && !out[action].every(isChordKey)) {
      const kept = canonicalBinding(defaults[action]);
      warn?.(`[keys] ${action} takes only a chord (Ctrl or Alt held, an F-key) — ${JSON.stringify(out[action])} would take a key that types from every field; kept ${JSON.stringify(kept)}`);
      out[action] = kept;
    }
  }
  return out;
}

// Two-phase input split. Observers (observe) are always active and do not
// consume — they run first in every state (screencasts/tutorials). Consumers
// (consume) are active only when priority(ui) > 0 and join the race. Both phases
// are sorted by priority(ui) — a dynamic priority: with the command line/overlay
// open, the corresponding handler rises to the top.
export function partitionInput(registry: LazyInputEntry[], ui: UiState = {}): { observers: InputEntry[]; consumers: InputEntry[] } {
  // The runtime may hand us lazy `{ get }` wrappers (flowtty-style) or already
  // resolved entries; unwrap lazily so this works regardless of the caller.
  const resolved = registry.map((e) => ('get' in e ? e.get() : e));
  const observers = resolved
    .filter(e => e.mode === 'observe')
    .sort((a, b) => (b.priority?.(ui) ?? 0) - (a.priority?.(ui) ?? 0));
  const consumers = resolved
    .filter(e => e.mode !== 'observe' && (e.priority?.(ui) ?? 0) > 0)
    .sort((a, b) => (b.priority?.(ui) ?? 0) - (a.priority?.(ui) ?? 0));
  return { observers, consumers };
}

// The consumer race: walk in priority order; the first handler to return STRICT
// `true` consumes the key (stops the race). `=== true` so a random truthy value
// (a number/string) doesn't eat the key. An empty array → false, control falls
// through to the residual monolith.
export function runConsumers(consumers: InputEntry[], key: InputKey, ui: UiState = {}): boolean {
  for (const c of consumers) {
    if (c.handler(key, ui) === true) return true;
  }
  return false;
}

// Pure gate for a trigger that opens a plugin modal on its own key: when the
// plugin may open itself via its key. We stay silent in the command line and
// with monolith modals open — there the same letter
// means something else (an input field/confirmation). Also silent when the plugin
// is already open: its input is handled by the base consumer (priority 100), not
// the trigger. `extraGate(ui)` is extra context (only on the board / only on the
// detail and so on) where the key means exactly this plugin opening.
export function triggerOpenable(ui: UiState, isOpen: boolean, extraGate: (ui: UiState) => boolean = () => true): boolean {
  if (ui.cmdOpen || ui.modalActive) return false;
  if (isOpen) return false;
  return extraGate(ui);
}

type TriggerHost = {
  useInputHandler: (opts: { mode: string; priority: (ui: UiState) => number; handler: (key: InputKey, ui: UiState) => boolean }) => void;
  keys?: Record<string, string | string[]>;
};
type AddTriggerArgs = {
  host: TriggerHost;
  action: string;
  isOpen: () => boolean;
  open: () => void;
  extraGate?: (ui: UiState) => boolean;
};

// Registers a trigger-open: while the modal is closed and the context fits, the
// plugin catches ONLY its key (foreign keys return false — the race continues),
// opens, and consumes (true). Priority 10 — below an open modal (100), above the
// residual monolith (0). So the host no longer knows "f opens filters" — the
// plugin registers its own open key itself.
export function addTrigger({ host, action, isOpen, open, extraGate = () => true }: AddTriggerArgs): void {
  host.useInputHandler({
    mode: 'consume',
    priority: (ui) => (triggerOpenable(ui, isOpen(), extraGate) ? 10 : 0),
    handler: (key, ui) => {
      if (triggerOpenable(ui, isOpen(), extraGate) && isKey(host.keys?.[action] ?? [], key.name ?? '')) {
        open();
        return true;
      }
      return false;
    },
  });
}

// A no-op placeholder view renderer: ignores props, renders nothing. Used in
// place of an absent surface render so a modal over it never throws.
const NOOP_VIEW: () => null = () => null;

// A safe placeholder for a surface/window renderer that is not wired into the
// runtime (e.g. a built-in modal opened with `renders: {}`). Returns a callable
// renderer — the real one if present, else the no-op — so a command over an
// absent render never throws "undefined is not a function": the command still
// works, the surface just renders blank.
export function renderFor<T extends unknown>(slot: unknown): T {
  return (slot == null ? NOOP_VIEW : slot) as T;
}

// Builds the surface registry: { surface: renderer }, merging the views of all
// plugins. The host namespaces each surface key with '<plugin.name>:<surface>'
// (later plugin wins over an earlier one for the same namespaced surface). Each
// surface is ALSO registered under its unqualified name (first plugin wins a
// bare surface) — the plugin modals read `viewRegistry.<surface>` source-
// faithfully (core reads .help, log reads .log, assistant reads .chat), so the
// bare alias is what the runtime actually needs; the namespaced form is kept
// for collision-free programmatic access. A falsy renderer (the built-in
// `renders` bundle handed `{}` at startup) is replaced by `renderFor`'s safe
// placeholder, so `:help`/`:ask`/`l` never crash.
export function buildViewRegistry(plugins: PluginShape[] = []): Record<string, unknown> {
  const registry: Record<string, unknown> = {};
  for (const p of plugins) {
    for (const [surface, renderer] of Object.entries(p.views ?? {})) {
      const safe = renderFor(renderer);
      registry[`${p.name}:${surface}`] = safe;
      if (!(surface in registry)) registry[surface] = safe;
    }
  }
  return registry;
}

// Every renderer the chat can draw a view with: the host's own `console`, and each
// plugin's, qualified by its name. Something that is not a function is not one.
export function collectViewRenderers(plugins: { name: string; viewRenderers?: Record<string, unknown> }[]): ViewRenderers {
  const table: ViewRenderers = { console: renderConsole };
  for (const p of plugins) {
    for (const [kind, fn] of Object.entries(p.viewRenderers ?? {})) {
      if (typeof fn === 'function') table[`${p.name}:${kind}`] = fn as ViewRenderer;
    }
  }
  return table;
}

// Who the assistant is talking to, for the chat system-context. Single source:
// `config.user` ({ name?, login? }) — never the environment and never the OS
// account, so nothing about the person reaches the LLM provider unless they
// wrote it into their own config. A login alone is shown verbatim: the host
// derives no name out of a login's shape.
export function chatUser(config: { user?: { name?: unknown; login?: unknown } } | null | undefined): { name: string; login: string } | null {
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = clean(config?.user?.name);
  const login = clean(config?.user?.login);
  if (!name && !login) return null;
  return { name: name || login, login };
}

// A plugin builder: `build<X>Plugin({ renders, config, make })` → Plugin. The
// host scans no filesystem here (the loader does); builders are passed in.
export type PluginBuilder = (ctx: { renders: unknown; config: Record<string, unknown>; make: Make }) => Plugin;

// Builds all plugins: maps each builder through `makeFactory(config)`. `renders`
// is a bundle of references to existing renderers that plugins reuse. Each
// builder is invoked synchronously with { renders, config, make }.
export function buildPlugins(
  renders: unknown,
  config: Record<string, unknown> = {},
  builtins: PluginBuilder[] = [],
): Plugin[] {
  const make = makeFactory(config as MakeFactoryConfig);
  return builtins.map((build) => build({ renders, config, make }));
}

// Builds the full host config schema: the host base (hostConfigSchema) plus the
// plugin namespaces config.plugins.<name>. A plugin that declares `configSchema`
// validates its slice strictly; without one we allow anything (z.unknown until it
// declares its own fields). The dynamic part (the plugin registry) lets
// `config plugins.<name>.<key>` add and validate values.
export function buildConfigSchema(plugins: PluginShape[] = []): z.ZodObject<any, any> {
  const namespaces: Record<string, z.ZodTypeAny> = Object.fromEntries(
    // Each namespace schema (.optional()) so a plugin that is not present in the
    // config is fine — z.unknown() alone would make the field REQUIRED and a config
    // listing only one plugin would fail parse on the missing others.
    plugins.map((p) => [p.name, ((p.configSchema ?? z.unknown()) as z.ZodTypeAny).optional()]),
  );
  // `plugins` stays OPTIONAL (the base hostConfigSchema has it `z.record(…).optional()`)
  // and PASSTHROUGH: a config without a `plugins` key must still parse (the host is
  // tracker-agnostic), and undeclared plugin-namespace keys are preserved rather than
  // stripped by a plain `z.object`. Known plugin namespaces are still validated.
  return hostConfigSchema.extend({
    plugins: z.object(namespaces).passthrough().optional(),
  });
}