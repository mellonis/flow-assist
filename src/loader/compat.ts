// Whether a plugin can run on this host, from its manifest alone — asked before the
// plugin's code is imported, wherever a plugin is listed, loaded or installed
// (docs/plugins.md, "Compatibility"). `pluginCompat` is pure: the host's numbers are
// passed in.
//
// - `hostApi`: the host API numbers the plugin works with — a number or a list of
//   them. Missing is 1. The plugin is compatible when the host's number is one of them.
// - `flowtty`: a semver range of the flowtty versions its screens need, checked against
//   the flowtty the host runs. Missing is accepted, with a note: a plugin with no
//   screens has nothing to check. A prerelease is matched only by a range that names
//   one — `^1.0.0` and `*` do not take `1.0.0-alpha.28`, `>=1.0.0-alpha.28 <1.0.0-alpha.29`
//   does.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FLOWTTY_VERSION, HOST_API } from '../version.js';

// Bun's semver, the one piece of Bun's own API the host's sources use (the host runs on
// Bun, compiled or not; its type definitions are not part of the typecheck).
declare const Bun: { semver: { satisfies(version: string, range: string): boolean } };

export interface HostVersions {
  api: number;
  flowtty: string;
}

export type Compat = { ok: true; note?: string } | { ok: false; reason: string };

// The numbers a manifest's `hostApi` names; null when it is neither a number nor a
// list of numbers.
export function hostApiSet(value: unknown): number[] | null {
  if (value === undefined) return [1];
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || !list.every((n) => Number.isInteger(n) && (n as number) > 0)) return null;
  return list as number[];
}

export function pluginCompat(manifest: Record<string, unknown> | null, host: HostVersions): Compat {
  // A manifest that is there and does not parse says nothing about what it is built for.
  if (manifest === null) return { ok: false, reason: 'manifest.json is not valid JSON' };
  const apis = hostApiSet(manifest.hostApi);
  if (!apis) return { ok: false, reason: `incompatible: hostApi ${JSON.stringify(manifest.hostApi)} is not a number or a list of numbers` };
  if (!apis.includes(host.api)) {
    return { ok: false, reason: `incompatible: built for host API${apis.length > 1 ? 's' : ''} ${apis.join(', ')}, host provides ${host.api}` };
  }
  const range = manifest.flowtty;
  if (range === undefined) return { ok: true, note: 'declares no flowtty range — loaded unchecked' };
  if (typeof range !== 'string' || !range.trim()) return { ok: false, reason: `incompatible: flowtty ${JSON.stringify(range)} is not a semver range` };
  let fits = false;
  try {
    fits = Bun.semver.satisfies(host.flowtty, range);
  } catch {
    fits = false;
  }
  return fits ? { ok: true } : { ok: false, reason: `incompatible: needs flowtty ${range}, host has ${host.flowtty}` };
}

// This host's numbers.
export const THIS_HOST: HostVersions = { api: HOST_API, flowtty: FLOWTTY_VERSION };

// The manifest of a plugin at `dir` — a directory with a manifest.json. A plugin that is
// a single file has none, and reads as `{}`: host API 1, no flowtty range. A
// manifest.json that is not a JSON object reads as null (`pluginCompat` says so).
export function readPluginManifest(dir: string): Record<string, unknown> | null {
  let text: string;
  try {
    if (statSync(dir).isFile()) return {};
    const file = join(dir, 'manifest.json');
    if (!existsSync(file)) return {};
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const m = JSON.parse(text) as unknown;
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
