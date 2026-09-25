// The remote plugin protocol, as types. JSON-RPC 2.0, one message per line, both
// directions; the host draws, the plugin describes (a `Frame`); the host's services
// are requests the plugin makes, what changes by itself is a notification the host
// sends. The number is the host API's: a plugin built for one host API speaks that
// host's protocol, and a change a plugin would break on bumps both.
export const PROTOCOL_HOST_API = 2;

// ─── The tree ─────────────────────────────────────────────────────────────────
// A node is `[type, props, ...children]`: `type` a component name from the host's
// `ui`, `props` a JSON object (two reserved: `key` for lists, `id` for a stateful node
// and the source of its events), children nodes or strings. A function prop never
// crosses the boundary: `onChange` and its kin become events by name.
export type NodeType = 'Box' | 'Text' | 'Markdown' | 'Table' | 'Link' | 'ScrollBox' | 'Select' | 'ListSelect' | 'ListMultiSelect' | 'Checkbox' | 'TextInput';
export type Props = Record<string, unknown>;
export type Node = [type: string, props?: Props | Node | string, ...children: (Node | string | null | undefined | false)[]];
export type Tree = Node;

export interface Keycap { action: string; label: string }
export type ConsumeSpec = string[] | '*';

// The plugin's whole visible state, sent whole and whenever the plugin wants.
export interface Frame {
  surface?: Tree | null;
  modals?: Record<string, Tree | null>;
  keycaps?: Array<Keycap | string>;
  context?: Array<{ label: string; text: string }>;
  keys?: { consume?: ConsumeSpec };
}

// ─── hello ────────────────────────────────────────────────────────────────────
export interface Size { width: number; height: number }
export interface HelloParams {
  hostApi: number;
  flowtty: string;
  size: { terminal: Size; surface: Size };
  config: Record<string, unknown>;
  idleMs: number;
  locale?: string;
}
export interface CommandDecl { name: string; usage?: string; description?: string; minArgs?: number; maxArgs?: number; history?: boolean; values?: Array<string | { value: string; label?: string }> }
export interface ToolDecl { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> }; write?: boolean; maxResultChars?: number; returnsImages?: boolean }
export interface ToolGroupDecl { id: string; tools: ToolDecl[] }
export interface HelloResult {
  hostApi: number | number[];
  name?: string;
  commands?: CommandDecl[];
  keys?: Record<string, string | string[]>;
  entry?: string[];
  tools?: ToolGroupDecl[];
  aiTools?: ToolDecl[];
  configSchema?: Record<string, unknown>; // JSON Schema
  colors?: Record<string, string>;
  modalColors?: Record<string, Record<string, string>>;
  usesCache?: boolean;
}

// ─── Events the host sends ────────────────────────────────────────────────────
export interface KeyEvent { name: string; id: string; ctrl?: boolean; meta?: boolean; shift?: boolean; action?: string }
export interface FieldEvent { id: string; value?: unknown }
export interface ResizeEvent { terminal: Size; surface: Size }
export interface VisibleEvent { surface: boolean }
export interface StoreEvent { key: string; value: unknown }

// ─── Requests the host makes ──────────────────────────────────────────────────
export interface ToolRunParams { name: string; args: Record<string, unknown>; call: { id: string } }
export interface ToolRunResult { result: unknown }
export interface CommandRunParams { name: string; arg: string }
export interface StyledSpan { text: string; bold?: boolean; dim?: boolean; underline?: boolean; color?: string; background?: string }
export interface ViewRenderParams { kind: string; data: unknown; width: number }
export interface ViewRenderResult { lines: StyledSpan[][] }

// The method names, so neither side spells one by hand.
export const HOST_REQUESTS = ['hello', 'tool.run', 'command.run', 'view.render', 'shutdown'] as const;
export const HOST_NOTIFICATIONS = ['key', 'changed', 'submitted', 'cancelled', 'toggled', 'resize', 'focus', 'blur', 'visible', 'store', 'cache.flushed', 'afterWrite'] as const;
export const PLUGIN_NOTIFICATIONS = ['frame'] as const;
export const PLUGIN_REQUESTS = ['host.showMessage', 'host.pushLog', 'host.chatLLM', 'host.copyToClipboard', 'host.store.get', 'host.store.set', 'host.cache.get', 'host.cache.set', 'host.cache.del', 'host.config.get'] as const;
