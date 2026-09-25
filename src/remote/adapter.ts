// A remote plugin as an ordinary `Plugin`. The loader hands this a transport to a
// process that speaks the protocol (docs/plugins.md, "A plugin in another language")
// and gets back the same object it gets from a JS module: `components.view` draws the
// last frame's `surface`, a furniture slot draws its modals and hears its keys,
// `keycaps` and `chatContext` read the last frame synchronously, `tools` and
// `commands` proxy to `tool.run` / `command.run`, `viewRenderers` answer from a cache
// filled by `view.render` (a placeholder until then), `configSchema` is the plugin's
// JSON Schema as zod. Nothing outside this file knows a plugin is remote.
//
// The frame is the plugin's whole visible state, sent whole whenever it wants; keys are
// consumed by what the frame declares (./keys.ts) and sent as events; a field's state
// is the host's (./fieldState.ts). A crash: the transport closes, the surface says
// `plugin stopped`, every tool throws that — one in flight included — and when the
// transport restarts `hello` runs again from an empty frame.
import { z } from 'zod';
import type { ReactElement } from 'react';
import { createPeer, PeerError, type ConsumeSpec, type Frame, type HelloParams, type HelloResult, type Peer, type StoreEvent, type StyledSpan, type ToolDecl, type ToolGroupDecl } from '@flow-assist/remote';
import type { Command, Make, Plugin } from '../loader/plugin.js';
import type { PluginApi } from '../runtime/plugin-api.js';
import { bumpViewRevision, type ViewLine, type ViewRenderer } from '../assistant/views.js';
import { overlay } from '../views/modals.js';
import { FLOWTTY_VERSION, HOST_API } from '../version.js';
import { validateFrame } from './frame.js';
import { drawFrame, focusedCount, type RenderCtx } from './tree.js';
import { createFieldState } from './fieldState.js';
import { canonicalConsume, consumes, keyEventFor, type Consume } from './keys.js';
import { localeFromEnv } from './locale.js';
import type { RemoteManifest, RestartingTransport, TransportClose } from './transport.js';

export const HELLO_TIMEOUT_MS = 10_000;
export const VIEW_RENDER_TIMEOUT_MS = 2_000;
export const COMMAND_TIMEOUT_MS = 5_000;
export const DEFAULT_IDLE_MS = 60_000;
// How long a transport that failed its handshake is given to stop, as the transport
// factory gives any child it stops.
const HELLO_FAILED_GRACE_MS = 3_000;
// The furniture handler's priority, by the host's convention (docs/plugins.md, keys):
// an open modal of the plugin's — the level the host's own modals take — hears its keys
// before any surface; the plugin's surface on screen is a base screen; off screen the
// plugin still hears the keys that lead in. Never 0: the host's race skips a handler
// at 0, and the plugin would hear nothing at all.
const MODAL_PRIORITY = 100;
const SURFACE_PRIORITY = 50;
const ENTRY_PRIORITY = 10;

export interface RemotePluginOpts {
  manifest: RemoteManifest & Record<string, unknown>;
  transport: RestartingTransport;
  config: Record<string, unknown>;
  make: Make;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  helloTimeoutMs?: number;
  // Where a `host.store.set` is told to the App's other remote plugins, and where this
  // one hears theirs (./index.ts holds the one the loader uses). Absent: nobody hears.
  storeBus?: StoreBus;
}

export interface StoreBus {
  // Joins the App whose `host.store` record this is; `hear` is told the others' writes.
  join(store: object, hear: (ev: StoreEvent) => void): void;
  // A member's write, told to every member of that App but `from`.
  said(store: object, from: (ev: StoreEvent) => void, ev: StoreEvent): void;
}

const EMPTY: Frame & { keys: { consume: ConsumeSpec } } = { surface: null, modals: {}, keycaps: [], context: [], keys: { consume: [] } };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function remotePlugin(opts: RemotePluginOpts): Promise<Plugin> {
  const { manifest, transport, make } = opts;
  const name = manifest.name;
  // Before the App is up a line goes to the loader's `log` (stderr and the loader's
  // notes); once `setup` has run it goes straight to the host's log, as the plugin's
  // own line rather than as a `[console.warn]` one.
  const log = (line: string) => {
    const pushLog = (api?.host.services as { pushLog?: (l: string) => void } | undefined)?.pushLog;
    if (pushLog) pushLog(line); else opts.log?.(line);
  };
  const say = (line: string) => log(`[${name}] ${line}`);
  const saidOnce = new Set<string>();
  const once = (key: string, line: string) => { if (!saidOnce.has(key)) { saidOnce.add(key); say(line); } };

  // ── the conversation ────────────────────────────────────────────────────────
  const peer: Peer = createPeer({ send: (l) => transport.send(l), onLine: (f) => transport.onLine(f) });
  peer.onUnknown((line) => once('unknown-line', `wrote a line that is not a message (skipped): ${line.slice(0, 120)}`));

  // ── what the host draws from: the last frame ────────────────────────────────
  let frame = EMPTY;
  // Counts the frames drawn: a root that failed to draw is tried again on the next one.
  let frameSeq = 0;
  // What the last frame consumes, resolved against the person's bindings once per
  // frame — in the key handler, where they are at hand (a frame may come before
  // `setup`).
  let consume: { of: typeof frame; keys: Consume } | null = null;
  let stopped: string | null = null; // `plugin stopped: …` while the process is down
  // Whether the surface was on screen when the process went: it stays there, saying so,
  // rather than leaving the person on the start screen with no word of what happened.
  let stoppedOnScreen = false;
  const fields = createFieldState();
  let api: PluginApi | null = null; // the pair the App hands `setup`, for services, config and notify
  const notify = () => api?.host.notify();
  // The plugin's slice of the config: the App's resolved config once `setup` has run,
  // the loader's before (the first `hello`).
  const pluginConfig = () => {
    const config = (api?.host.config ?? opts.config) as { plugins?: Record<string, unknown> };
    return (config.plugins?.[name] ?? {}) as Record<string, unknown>;
  };
  peer.onNotify('frame', (raw) => {
    const v = validateFrame(raw, JSON.stringify(raw ?? null).length);
    if (!v.ok) { say(`frame dropped: ${v.why}`); return; }
    frame = v.frame;
    frameSeq++;
    for (const [where, tree] of [['the surface', frame.surface ?? null], ...Object.entries(frame.modals ?? {}).map(([m, t]) => [`modal ${m}`, t] as const)] as const) {
      const n = focusedCount(tree);
      if (n > 1) once(`focused:${where}`, `${where} has ${n} focused nodes — only one can have the keyboard`);
    }
    fields.applyFrame(frame.surface ?? null, frame.modals ?? {});
    stopped = null;
    notify();
  });

  // ── host.* — the services as requests ───────────────────────────────────────
  const services = () => (api?.host.services ?? {}) as Record<string, any>;
  const storeSlice = () => {
    const store = (api?.host.store ?? {}) as Record<string, unknown>;
    return ((store[name] ??= {}) as Record<string, unknown>);
  };
  const param = <T,>(p: unknown, key: string, type: string): T => {
    const v = (p as Record<string, unknown> | null)?.[key];
    if (typeof v !== type) throw new PeerError(`${key} (${type}) is required`, PeerError.INVALID_PARAMS);
    return v as T;
  };
  peer.onRequest('host.showMessage', (p) => { services().showMessage?.(param<string>(p, 'text', 'string')); });
  peer.onRequest('host.pushLog', (p) => { services().pushLog?.(`[${name}] ${param<string>(p, 'text', 'string')}`); });
  peer.onRequest('host.copyToClipboard', (p) => { services().copyToClipboard?.(param<string>(p, 'text', 'string')); });
  peer.onRequest('host.chatLLM', async (p) => {
    const messages = (p as { messages?: unknown })?.messages;
    if (!Array.isArray(messages)) throw new PeerError('messages (array) is required', PeerError.INVALID_PARAMS);
    const r = await services().chatLLM?.(messages, {});
    return { content: r?.content ?? '', transcript: r?.transcript ?? [] };
  });
  peer.onRequest('host.store.get', (p) => storeSlice()[param<string>(p, 'key', 'string')] ?? null);
  // Told on to the App's other remote plugins as the host.store key that changed — this
  // plugin's name — and its slice whole (./index.ts).
  const hearStore = (ev: StoreEvent) => send('store', ev);
  peer.onRequest('host.store.set', (p) => {
    const slice = storeSlice();
    slice[param<string>(p, 'key', 'string')] = (p as { value?: unknown }).value;
    if (api) opts.storeBus?.said(api.host.store, hearStore, { key: name, value: slice });
    notify();
  });
  peer.onRequest('host.cache.get', (p) => services().cache?.get?.(param<string>(p, 'key', 'string')) ?? null);
  peer.onRequest('host.cache.set', (p) => services().cache?.set?.(param<string>(p, 'key', 'string'), (p as { value?: unknown }).value));
  peer.onRequest('host.cache.del', (p) => services().cache?.del?.(param<string>(p, 'key', 'string')));
  peer.onRequest('host.config.get', () => pluginConfig());

  // ── hello ───────────────────────────────────────────────────────────────────
  let sizes = { terminal: { width: 80, height: 24 }, surface: { width: 80, height: 22 } };
  const helloTimeout = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const helloParams = (): HelloParams => {
    const locale = localeFromEnv(opts.env ?? process.env);
    return { hostApi: HOST_API, flowtty: FLOWTTY_VERSION, size: sizes, config: pluginConfig(), idleMs: DEFAULT_IDLE_MS, ...(locale ? { locale } : {}) };
  };
  // What a registration must be to be used: a malformed one fails the handshake rather
  // than the loader, so the process is stopped like any other refused `hello`.
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const listOf = (r: HelloResult, field: keyof HelloResult, ok: (v: unknown) => boolean, what: string) => {
    const v = r[field];
    if (v === undefined) return;
    if (!Array.isArray(v) || !v.every(ok)) throw new Error(`hello: ${field} is not a list of ${what}`);
  };
  const isToolDecl = (t: unknown) => isObj(t) && isObj(t.function) && typeof t.function.name === 'string';
  const checkRegistration = (r: HelloResult): { schema: unknown } => {
    listOf(r, 'tools', (g) => isObj(g) && typeof g.id === 'string' && Array.isArray(g.tools) && g.tools.every(isToolDecl), 'tool groups ({ id, tools })');
    listOf(r, 'aiTools', isToolDecl, 'tools');
    listOf(r, 'commands', (c) => isObj(c) && typeof c.name === 'string', 'commands ({ name })');
    listOf(r, 'entry', (e) => typeof e === 'string', 'action names');
    if (r.keys !== undefined && (!isObj(r.keys) || !Object.values(r.keys).every((b) => typeof b === 'string' || (Array.isArray(b) && b.every((k) => typeof k === 'string'))))) throw new Error('hello: keys is not a map of action to key or keys');
    if (r.configSchema === undefined) return { schema: undefined };
    if (!isObj(r.configSchema)) throw new Error('hello: configSchema is not a JSON Schema object');
    try { return { schema: z.fromJSONSchema(r.configSchema as never).optional() }; }
    catch (e) { throw new Error(`hello: configSchema is not a JSON Schema zod reads: ${message(e)}`); }
  };
  // Every way a handshake fails reads `hello: …` — the peer's own timeout already does.
  const sayHello = async (): Promise<HelloResult & { schema: unknown }> => {
    let r: HelloResult | null;
    try { r = (await peer.request('hello', helloParams(), helloTimeout)) as HelloResult | null; }
    catch (e) { const m = message(e); throw new Error(m.startsWith('hello:') ? m : `hello: ${m}`); }
    if (!r || typeof r !== 'object') throw new Error('hello: the plugin answered with nothing');
    if (typeof r.name === 'string' && r.name !== name) throw new Error(`hello: the plugin says it is "${r.name}", the manifest says "${name}"`);
    const apis = Array.isArray(r.hostApi) ? r.hostApi : [r.hostApi];
    if (!apis.includes(HOST_API)) throw new Error(`hello: built for host API ${apis.join(', ')}, host provides ${HOST_API}`);
    return { ...r, ...checkRegistration(r) };
  };
  await transport.start();
  let registration: HelloResult & { schema: unknown };
  try { registration = await sayHello(); } catch (e) {
    await transport.close(HELLO_FAILED_GRACE_MS);
    throw e;
  }

  // ── the events the host sends ───────────────────────────────────────────────
  const send = (method: string, params?: unknown) => { if (!stopped) peer.notify(method, params); };
  let focused: boolean | null = null; // the last `focus`/`blur` said, told again after a restart
  // Whether the plugin's side is on screen: not while the chat is `full` and open over
  // it (the surface stays mounted under the chat, so this is read from the chat's own
  // `host.store.chat`, not from a mount). Assumed at start, said on change and told
  // again after a restart.
  let visible = true;

  // ── after a crash ───────────────────────────────────────────────────────────
  // A request in flight when the process goes is rejected at once rather than left to
  // its timeout: the answer it waits for cannot come.
  const inFlight = new Set<(e: Error) => void>();
  const untilStopped = <T,>(p: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    inFlight.add(reject);
    p.then(resolve, reject).finally(() => inFlight.delete(reject));
  });
  transport.onClose((why: TransportClose) => {
    stopped = `plugin stopped${why.error ? `: ${why.error}` : why.signal ? ` (${why.signal})` : why.code !== undefined ? ` (exit ${why.code})` : ''}`;
    // A process that goes again before its first frame leaves the screen as the last
    // stop left it: only a frame says what is on screen.
    stoppedOnScreen = (frame.keycaps ?? []).length > 0 || (stoppedOnScreen && frame === EMPTY);
    frame = EMPTY;
    frameSeq++;
    fields.applyFrame(null, {});
    for (const reject of inFlight) reject(new Error(stopped));
    inFlight.clear();
    say(stopped);
    notify();
  });
  // The frame is not reset here: it was emptied at the close, and a frame the new
  // process sends before answering `hello` is its first.
  transport.onRestart(() => {
    sayHello().then(() => {
      stopped = null;
      if (focused !== null) send(focused ? 'focus' : 'blur');
      if (!visible) send('visible', { surface: false });
      say('restarted');
      notify();
    }, (e: unknown) => {
      // The new process refused its handshake: it is stopped, and the close that follows
      // is the supervisor's to count.
      say(`restart failed: ${message(e)}`);
      void transport.close(HELLO_FAILED_GRACE_MS);
    });
  });

  // The view kinds the plugin renders. They come from the manifest, not `hello`: the
  // host collects every renderer at App start, before any tool has run.
  const kinds = Array.isArray(manifest.views) ? manifest.views.filter((k): k is string => typeof k === 'string') : [];

  // ── tools: proxies to tool.run ──────────────────────────────────────────────
  let callSeq = 0;
  // A tool may answer `{ result, views: [{ kind, data }] }`: each view is reported on the
  // call's own `ctx.reportView`, as a JS tool reports one — a kind the manifest does not
  // declare has no renderer and is dropped, said once.
  const reportViews = (views: unknown, ctx: Record<string, unknown> | undefined) => {
    if (!Array.isArray(views)) return;
    const report = ctx?.reportView as ((kind: string, data: unknown) => unknown) | undefined;
    for (const v of views) {
      if (!v || typeof v !== 'object' || typeof (v as { kind?: unknown }).kind !== 'string') continue;
      const { kind, data } = v as { kind: string; data?: unknown };
      if (!kinds.includes(kind)) { once(`view-undeclared:${kind}`, `tool reported view "${kind}", which the manifest's views do not declare (dropped)`); continue; }
      report?.(kind, data);
    }
  };
  const runTool = async (toolName: string, args: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<unknown> => {
    if (stopped) throw new Error(stopped);
    let answer: unknown;
    try { answer = await untilStopped(peer.request('tool.run', { name: toolName, args, call: { id: `${name}-${++callSeq}` } })); }
    catch (e) { throw new Error(message(e)); }
    if (typeof answer === 'string') return answer;
    if (answer && typeof answer === 'object' && 'result' in (answer as object)) {
      reportViews((answer as { views?: unknown }).views, ctx);
      return (answer as { result: unknown }).result;
    }
    throw new Error(`${toolName}: the plugin answered with ${JSON.stringify(answer)}, not { result }`);
  };
  const toolGroups = (registration.tools ?? []).map((g: ToolGroupDecl) => ({
    id: g.id,
    tools: g.tools,
    exec: (n: string, args: Record<string, unknown>, ctx?: Record<string, unknown>) => runTool(n, args, ctx),
  }));
  const aiTools = (registration.aiTools ?? []).map((t: ToolDecl) => ({ ...t, run: (args: Record<string, unknown>, ctx?: Record<string, unknown>) => runTool(t.function.name, args, ctx) }));

  // ── commands ────────────────────────────────────────────────────────────────
  const commands: Command[] = (registration.commands ?? []).map((c) => ({
    ...c,
    run: async (_ctx?: unknown, arg?: string) => {
      if (stopped) { services().showMessage?.(stopped); return; }
      try { await untilStopped(peer.request('command.run', { name: c.name, arg: arg ?? '' }, COMMAND_TIMEOUT_MS)); }
      catch (e) { services().showMessage?.(`${c.name}: ${message(e)}`); }
    },
  }));

  // ── view renderers: a cache behind a placeholder ────────────────────────────
  const rendered = new Map<string, ViewLine[]>();
  const asked = new Set<string>();
  const viewRenderers: Record<string, ViewRenderer> = {};
  const toViewLines = (lines: unknown): ViewLine[] => (Array.isArray(lines) ? lines.map((l) => (Array.isArray(l) ? l.filter((s): s is StyledSpan => !!s && typeof s === 'object' && typeof (s as StyledSpan).text === 'string').map((s) => ({ text: s.text, ...(s.color ? { color: s.color } : {}), ...(s.dim ? { dim: true } : {}), ...(s.bold ? { bold: true } : {}) })) : [])) : []);
  const renderer = (kind: string): ViewRenderer => (data, ctx) => {
    const key = `${kind}\u0000${JSON.stringify(data)}\u0000${ctx.width}`;
    const hit = rendered.get(key);
    if (hit) return hit;
    if (!asked.has(key) && !stopped) {
      asked.add(key);
      peer.request('view.render', { kind, data, width: ctx.width }, VIEW_RENDER_TIMEOUT_MS).then((r) => {
        rendered.set(key, toViewLines((r as { lines?: unknown } | null)?.lines));
        // The chat keeps a finished message's rows; this is what makes them miss.
        bumpViewRevision();
        notify();
      }, (e: unknown) => {
        // A timeout is asked again on the next draw; a refusal (`-32601` and its kin) is
        // the plugin's answer, and asking on every redraw would not change it.
        if (!(e instanceof PeerError) || e.code === PeerError.TIMEOUT || e.code === PeerError.CLOSED) asked.delete(key);
        once(`view:${kind}`, `view.render ${kind}: ${message(e)}`);
      });
    }
    return [[{ text: `▸ ${kind}`, dim: true }]];
  };
  for (const kind of kinds) viewRenderers[kind] = renderer(kind);

  // ── keys ────────────────────────────────────────────────────────────────────
  // The key event names an action only among the plugin's own (`hello.keys`), bound as
  // the person's config resolves them.
  const ownActions = Object.keys(registration.keys ?? {});
  const ownBindings = (host: PluginApi['host']) => Object.fromEntries(ownActions.map((a) => [a, host.keys[a] ?? []]));
  const consumeOf = (host: PluginApi['host']): Consume => {
    if (consume?.of !== frame) consume = { of: frame, keys: canonicalConsume(frame.keys.consume, ownBindings(host)) };
    return consume.keys;
  };

  // ── the components ──────────────────────────────────────────────────────────
  const treeCtx = (ui: PluginApi['ui'], hasKeyboard: boolean): RenderCtx => ({ ui, hasKeyboard, state: fields, onEvent: (m, ev) => send(m, ev), redraw: notify, warn: (l) => once(`prop:${l}`, l) });
  const frameFailed = (m: string) => once(`frame-failed:${m}`, `frame failed: ${m}`);
  const draw = (tree: Parameters<typeof drawFrame>[0], ctx: RenderCtx) => drawFrame(tree, ctx, frameSeq, frameFailed);
  const openModals = () => Object.entries(frame.modals ?? {}).filter(([, t]) => t);
  const components: Record<string, (a: unknown) => unknown> = {
    // The surface: mounted while the plugin's keycaps say it is on screen.
    view: (a) => {
      const { ui, host } = a as PluginApi;
      return function RemoteSurface(): ReactElement | null {
        // An open modal of the plugin's has the keyboard, as the host's own modals do over
        // a surface: a focused field under it must not hear what is typed into the modal.
        const hasKeyboard = host.hasKeyboard() && openModals().length === 0;
        if (stopped) return ui.h(ui.Box, { padding: 1 }, ui.h(ui.Text, { color: 'red' }, stopped));
        return draw(frame.surface ?? null, treeCtx(ui, hasKeyboard));
      };
    },
    // Furniture, always mounted: the modals, and what the plugin hears whether or not
    // its surface is up — its keys (the one that leads in from the start screen too),
    // its size and whether it has the keyboard.
    modals: (a) => {
      const { ui, host } = a as PluginApi;
      return function RemoteModals(): ReactElement | null {
        const hasKeyboard = host.hasKeyboard();
        const terminal = host.useTerminalSize();
        const surface = host.useSurfaceSize();
        ui.useEffect(() => {
          if (terminal.width !== sizes.terminal.width || terminal.height !== sizes.terminal.height || surface.width !== sizes.surface.width || surface.height !== sizes.surface.height) {
            sizes = { terminal: { width: terminal.width, height: terminal.height }, surface: { width: surface.width, height: surface.height } };
            send('resize', sizes);
          }
        }, [terminal.width, terminal.height, surface.width, surface.height]);
        ui.useEffect(() => { focused = hasKeyboard; send(hasKeyboard ? 'focus' : 'blur'); }, [hasKeyboard]);
        const chat = (host.store as { chat?: { open?: boolean; layout?: string } }).chat;
        const shown = !(chat?.open && chat.layout === 'full');
        ui.useEffect(() => { if (shown !== visible) { visible = shown; send('visible', { surface: shown }); } }, [shown]);
        // A cache flush (`x`) counts up `services.cacheEpoch`; the plugin is told of each
        // one, never of the count it started with.
        const epoch = (host.services as { cacheEpoch?: number }).cacheEpoch ?? 0;
        const seenEpoch = ui.useRef(epoch);
        ui.useEffect(() => { if (epoch !== seenEpoch.current) { seenEpoch.current = epoch; send('cache.flushed'); } }, [epoch]);
        host.useInputHandler({
          mode: 'consume',
          priority: (u) => (u.cmdOpen ? 0 : openModals().length ? MODAL_PRIORITY : frame.keycaps?.length ? SURFACE_PRIORITY : ENTRY_PRIORITY),
          handler: (key) => {
            if (stopped || !host.hasKeyboard() || !consumes(consumeOf(host), key)) return false;
            send('key', keyEventFor(key, ownBindings(host)));
            return true;
          },
        });
        const open = openModals();
        if (!open.length) return null;
        const { width, height } = terminal;
        // Each overlay is a root of the slot, as the host's own modals are: a box around
        // them would be laid out after the surface and move their `top: 0, left: 0`.
        return ui.h(ui.Fragment, undefined, ...open.map(([modal, tree]) => ui.h(ui.Box, { key: modal, ...overlay(width, height) }, draw(tree!, treeCtx(ui, hasKeyboard)))));
      };
    },
  };

  const keys = Object.fromEntries(Object.entries(registration.keys ?? {}).map(([a, b]) => [a, Array.isArray(b) ? b : [b]]));
  return make(name, {
    name,
    keys,
    entry: registration.entry,
    description: typeof manifest.description === 'string' ? manifest.description.trim() || undefined : undefined,
    commands,
    tools: toolGroups,
    aiTools,
    viewRenderers: viewRenderers as Plugin['viewRenderers'],
    colors: registration.colors,
    modalColors: registration.modalColors,
    usesCache: registration.usesCache ?? false,
    configSchema: registration.schema,
    components,
    setup: (a) => { api = a as PluginApi; opts.storeBus?.join(api.host.store, hearStore); },
    // The guest rule reads `keycaps` alone, so a surface that was up when the process
    // went keeps one — the stop itself — and stays mounted to say it; its keys are dead.
    keycaps: (a) => {
      if (stopped) return stoppedOnScreen ? [stopped] : [];
      const keyCap = (a as PluginApi | undefined)?.host?.keyCap ?? (() => '');
      return (frame.keycaps ?? []).flatMap((k) => (typeof k === 'string' ? [k] : keyCap(k.action) ? [`${keyCap(k.action)} ${k.label}`] : []));
    },
    chatContext: () => frame.context ?? [],
    afterWrite: () => { send('afterWrite'); },
  });
}
