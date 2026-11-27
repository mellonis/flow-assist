// A plugin's palette and its preview, read from its manifest.json — the same for a JS
// plugin and a remote one.
//
// - `colors`: the defaults of the plugin's surface, `{ key: value }` with each value a
//   flowtty colour or a `${base.<role>}`. One record stands on both schemes; a record
//   whose keys are `dark` and `light`, each a record, keeps the two schemes apart, and a
//   scheme it leaves out takes the other's.
// - `preview`: a static node tree in the remote protocol's frame format, the specimen a
//   tuner draws for the plugin. It must pass the checks a frame's surface passes.
//
// What the host cannot take is dropped and said in `notes`; the plugin loads without it.

import { checkTree } from '../remote/frame.js';
import { isColorValue } from '../playback/palette-config.js';

export interface ManifestPalette {
  palette?: { dark: Record<string, string>; light: Record<string, string> };
  preview?: unknown;
  notes: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// The keys of one record whose values the palette takes; each other key is a note.
function readKeys(record: Record<string, unknown>, where: string, notes: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && isColorValue(value)) out[key] = value;
    else notes.push(`${where}.${key} ${JSON.stringify(value)} is not a colour or a \${base.<role>} — not applied`);
  }
  return out;
}

// `{ dark, light }` — the keys are scheme names only, each a record.
function isSplit(colors: Record<string, unknown>): boolean {
  const keys = Object.keys(colors);
  return keys.length > 0 && keys.every((k) => (k === 'dark' || k === 'light') && isRecord(colors[k]));
}

export function readManifestPalette(manifest: Record<string, unknown>): ManifestPalette {
  const notes: string[] = [];
  const out: ManifestPalette = { notes };
  const { colors, preview } = manifest;
  if (colors !== undefined) {
    if (!isRecord(colors)) {
      notes.push(`colors ${JSON.stringify(colors)} is not a record of colours — no palette`);
    } else if (isSplit(colors)) {
      const dark = isRecord(colors.dark) ? readKeys(colors.dark, 'colors.dark', notes) : undefined;
      const light = isRecord(colors.light) ? readKeys(colors.light, 'colors.light', notes) : undefined;
      out.palette = { dark: { ...(dark ?? light) }, light: { ...(light ?? dark) } };
    } else {
      const keys = readKeys(colors, 'colors', notes);
      out.palette = { dark: { ...keys }, light: { ...keys } };
    }
  }
  if (preview !== undefined) {
    const bad = preview === null ? 'preview is not a node ([type, props, ...children])' : checkTree(preview, 1, 'preview');
    if (bad) notes.push(`${bad} — no preview`);
    else out.preview = preview;
  }
  return out;
}
