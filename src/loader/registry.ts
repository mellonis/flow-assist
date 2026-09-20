// Plugin registry. Pure factory + helper builders over the plugin shape. The
// host is tracker-agnostic: registry keys are namespaced on load — surfaces are
// stored as '<plugin.name>:<surface>' and command names are prefixed with
// '<plugin.name>:<name>', so plugins never collide with the host's base command
// set. Key bindings are merged BY ACTION NAME (not namespaced).

import { z } from 'zod';
import { HOST_DEFAULT_KEYS, isKey } from '../playback/keys.js';
import { hostConfigSchema } from '../config/schema.js';
import { BASE_COMMANDS, helpText } from '../config/commands.js';
import type { Command as BaseCommand } from '../config/commands.js';
import { makeFactory } from './plugin.js';
import type { Command, Make, MakeFactoryConfig, Plugin, PluginShape } from './plugin.js';

// ─── Input types ────────────────────────────────────────────────────────────
// `ui` is the host's input state — the fields the trigger gate cares about.
// `overlay` names the plugin surface currently shown as a favored overlay (e.g.
// a tracker's detail view): while set, the input race must give that surface the
// key (see detailPriority). Generic — any plugin may open an overlay via the
// host's `setOverlay` service; the value is plugin-defined.
type UiState = { cmdOpen?: boolean; welcome?: boolean; searchMode?: boolean; modalActive?: boolean; overlay?: string };
// A keyboard event (flowtty reports a `name` plus raw fields).
type InputKey = { name?: string; [k: string]: unknown };
// A resolved input handler — the shape flowtty's `useInputHandler` receives.
type InputEntry = {
  mode: string;
  priority?: (ui: UiState) => number;
  handler: (key: InputKey, ui: UiState) => unknown;
};
// A registry entry: either the resolved handler, or a lazy `{ get }` wrapper
// (the runtime stores handlers behind `get: () => ref.current`).
type LazyInputEntry = InputEntry | { get: () => InputEntry };
// Navigation state (what the base-view predicates read).
type Nav = { view?: string; boardView?: boolean; searchMode?: boolean; welcome?: boolean };

// ─── Predicates (the host keeps them; the tracker uses them) ────────────────
// Is the board active as the base view (nav part): the issues list is shown but
// board mode is on and global search is not. Fold/unfold, card navigation and
// opening an issue are only possible in this state; in list/sprints/search the
// board is not drawn and does not intercept input.
export function boardNavActive(nav: Nav): boolean {
  return nav.view === 'issues' && !!nav.boardView && !nav.searchMode;
}

// Sprints — the default top-level view (view === 'sprints'). Unlike the board
// (whose boardView is off during the welcome bootstrap), sprints may be "active"
// UNDER the welcome overlay and search, so the predicate accounts for that: if
// welcome or search is open, sprints are not drawn and do not intercept input.
export function sprintsNavActive(nav: Nav): boolean {
  return nav.view === 'sprints' && !nav.searchMode && !nav.welcome;
}

// Issues list — view === 'issues' when the board is not active and not in search.
// Search draws its surface over issues (renderView), and the board draws its own
// view (boardView); in both cases the issues list is not drawn/intercepts input.
export function issuesListActive(nav: Nav): boolean {
  return nav.view === 'issues' && !nav.boardView && !nav.searchMode && !nav.welcome;
}

// Search — a mode layered over the base view (`searchMode`). While searching, it
// draws its own surface and consumes ALL input. With search on, the base view
// underneath is not drawn (issues-list/board/sprints are off via searchMode).
export function searchActive(nav: Nav): boolean {
  return !!nav.searchMode && !nav.welcome;
}

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
// plugin command that forwards to, say, `ctx.openIssue(arg)` would find no such
// method and silently no-op. Here we extend the base ctx with the OWNING
// plugin's own-key services (the per-plugin `pFt.services` the plugin's own
// mount mutates: openIssue/openBoard/openBrowser/toggleBookmark/…). The host
// stays agnostic — it never names a plugin method; it just spreads them.
//
// Precedence: base ctx wins over plugin services (`...services, ...baseCtx`), so
// a plugin's no-op `showMessage` never shadows the host's real toast. A base
// command (no ':') or a plugin with no mounted pFt gets the base ctx unchanged.
export function commandContextFor(
  cmd: Command,
  baseCtx: Record<string, unknown>,
  pFtMap: Record<string, { services?: Record<string, unknown> }> = {},
): Record<string, unknown> {
  const pluginName = cmd.name.includes(':') ? cmd.name.split(':')[0] : null;
  const services = pluginName ? pFtMap[pluginName]?.services : undefined;
  return services ? { ...services, ...baseCtx } : baseCtx;
}

// Help text for a registry (sort + usage + description), reusing the shared
// `helpText` helper which accepts any command array.
export function helpFor(registry: Command[]): string {
  return helpText(registry as BaseCommand[]);
}

// The host footer composition (spec: plugin footer hints + universal openBrowser).
// The footer = host base (`: commands` + `q quit`, derived from `keys` so a user
// remap is respected) + each plugin's non-empty `keycaps(ft)`. A plugin's
// `keycaps` returns `[]` when its surface is inactive, so an empty screen
// collapses to `: commands · q quit`. `x flush cache` joins only when a plugin
// context is active (content present). `pFtMap[plugin.name]` is each plugin's
// runtime (from the App's overlayComps), which `keycaps` reads for live state;
// a plugin whose `pFt` is not mounted yet (or that declares no keycaps) simply
// contributes nothing. Pure — no imports beyond the plugin shape.
export function composeFooterHints(
  plugins: PluginShape[] = [],
  pFtMap: Record<string, unknown> = {},
  keys: Record<string, string[]> = {},
): string[] {
  const keyStr = (action: string): string => (keys[action] ?? []).join('/');
  const hints: string[] = [': commands', `${keyStr('quit') || 'q'} quit`];
  const pluginHints = plugins
    .map((p) => {
      const kc = (p as Plugin).keycaps;
      const pFt = pFtMap[p.name];
      return kc && pFt ? kc(pFt) : [];
    })
    .filter((h) => h.length);
  if (pluginHints.length) hints.push(`${keyStr('clearCache') || 'x'} flush cache`);
  return [...hints, ...pluginHints.flat()];
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
export function buildKeys(
  plugins: PluginShape[] = [],
  config: KeysConfig = {},
  base: Record<string, string | string[]> = HOST_DEFAULT_KEYS,
): Record<string, string[]> {
  const toArr = (v: string | string[] | null | undefined): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const merged: Record<string, string | string[]> = { ...base };
  for (const p of plugins) {
    const pk = p.keys ?? p.keyActions ?? {};
    const pKeys = config?.plugins?.[p.name]?.keys;
    for (const [action, binding] of Object.entries(pk)) {
      merged[action] = pKeys?.[action] ?? binding;
    }
  }
  const out: Record<string, string[]> = {};
  for (const [action, def] of Object.entries(merged)) {
    out[action] = toArr(config?.keys?.[action] ?? def);
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

// Pure calculation of the next bookmarks array for a toggle (m on list/board/
// detail). A mirror of useBookmarks.toggleBookmark without writing host state:
// the result is published into ft.store.bookmarks SYNCHRONOUSLY (see
// applyBookmarkMutation).
export function nextBookmarksOnToggle(bookmarks: string[], id: string): string[] {
  return bookmarks.includes(id) ? bookmarks.filter(c => c !== id) : [...bookmarks, id];
}

// Same, for removing a bookmark from the bookmarks popup (its list renders
// separately).
export function nextBookmarksOnRemove(bookmarks: string[], id: string): string[] {
  return bookmarks.filter(c => c !== id);
}

type BookmarkStore = { bookmarks?: string[] };
type ApplyBookmarkArgs = {
  bookmarks: string[];
  store?: BookmarkStore | null;
  setBookmarks: (b: string[]) => void;
  persist: (b: string[]) => void;
  notify: () => void;
  computeNext: (b: string[]) => string[];
};

// A bookmark mutation affecting the ★ marker of the base views (board/list/
// detail). Returns the new array and GUARANTEES a synchronous publish into
// store.bookmarks BEFORE calling notify. Why this matters: the bookmarks state
// lives in a descendant component (App) while the base views read
// ft.store.bookmarks.bookmarks in their OWN render. React commits in tree order
// — App (and the board under it) renders EARLIER than the owning component would
// re-publish the store, so a deferred publish would leave the board the old list
// and ★ would only appear after the next re-render. setBookmarks/persist/notify
// are the component's callbacks; store is the current ft.store.bookmarks (we
// mutate the field).
export function applyBookmarkMutation({ bookmarks, store, setBookmarks, persist, notify, computeNext }: ApplyBookmarkArgs): string[] {
  const next = computeNext(bookmarks);
  setBookmarks(next);
  persist(next);
  if (store) store.bookmarks = next;
  notify();
  return next;
}

// Pure gate for a trigger that opens a plugin modal on its own key: when the
// plugin may open itself via its key. We stay silent in the command line /
// welcome / global search and with monolith modals open — there the same letter
// means something else (an input field/confirmation). Also silent when the plugin
// is already open: its input is handled by the base consumer (priority 100), not
// the trigger. `extraGate(ui)` is extra context (only on the board / only on the
// detail and so on) where the key means exactly this plugin opening.
export function triggerOpenable(ui: UiState, isOpen: boolean, extraGate: (ui: UiState) => boolean = () => true): boolean {
  if (ui.cmdOpen || ui.welcome || ui.searchMode || ui.modalActive) return false;
  if (isOpen) return false;
  return extraGate(ui);
}

type TriggerFT = {
  useInputHandler: (opts: { mode: string; priority: (ui: UiState) => number; handler: (key: InputKey, ui: UiState) => boolean }) => void;
  keys?: Record<string, string | string[]>;
};
type AddTriggerArgs = {
  ft: TriggerFT;
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
export function addTrigger({ ft, action, isOpen, open, extraGate = () => true }: AddTriggerArgs): void {
  ft.useInputHandler({
    mode: 'consume',
    priority: (ui) => (triggerOpenable(ui, isOpen(), extraGate) ? 10 : 0),
    handler: (key, ui) => {
      if (triggerOpenable(ui, isOpen(), extraGate) && isKey(ft.keys?.[action] ?? [], key.name ?? '')) {
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