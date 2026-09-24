// The host's own start screen.
//
// A plugin is a guest: mounting every plugin component from the first frame would
// draw a plugin's own screen — a tracker plugin's board, with no board chosen saying
// "No board data" — over an assistant that had not been asked for a board. Until the
// person opens something of its own, the screen is the HOST's: who this is, and what
// can be done from here.
import { createElement as h } from 'react';
import { Box, Text } from '@flowtty/react';
import { bindingGlyph } from '../playback/keys.js';

// ƒ — the assistant's mark — drawn large with box-drawing characters: the hook, the
// crossbar, the tail. Every glyph is one narrow code point (flowtty counts one cell
// per code point), so the rows line up in any terminal.
export const LOGO = [
  '    ╭──╮',
  '    │   ',
  '  ╶─┼─╴ ',
  '    │   ',
  ' ╰──╯   ',
];

interface HomePlugin { name: string; description?: string; entry?: string[]; tools?: unknown[]; aiTools?: unknown[] }

export function renderHome({ title, plugins, keys, builtins, width = 80, accent = 'green', pluginsNote }: {
  title: string;
  plugins: HomePlugin[];
  // The resolved key map — so what is shown is what is bound NOW.
  keys: Record<string, string[]>;
  // Names of the host's own plugins: they are the host, not something to list.
  builtins: string[];
  // Terminal width, to size the column of descriptions.
  width?: number;
  accent?: string;
  // Where the host looked for plugins and found none. Shown in the plugins' place, so
  // an empty list says where it came from instead of just being missing.
  pluginsNote?: string;
}) {
  const cap = (action: string) => bindingGlyph(keys[action]);
  // What a person can do from here, each only if its key is bound.
  const doors: Array<[string, string]> = [
    [cap('chat'), 'talk to the assistant'],
    [cap('commandLine'), 'commands — try :help'],
    // No key quits by default — then the way out is the command, and the screen says so.
    [cap('quit') || (cap('commandLine') ? `${cap('commandLine')}q` : ''), 'quit'],
  ].filter(([key]) => key) as Array<[string, string]>;
  const pad = Math.max(...doors.map(([key]) => Array.from(key).length), 1);

  // Guests: enabled plugins, and the keys each one binds — the way in to a plugin
  // that has a screen of its own. A tool-only plugin has none and is named as such.
  const guests = plugins.filter((p) => !builtins.includes(p.name)).map((p) => {
    // Only the keys the plugin NAMES as its way in (`entry`). Listing every key it
    // binds read as instructions — "⏎ open" beside a tracker with no board open —
    // and pressing them did nothing.
    const bound = (p.entry ?? [])
      .map((action) => ({ action, key: cap(action) }))
      .filter((b) => b.key);
    const tools = (p.tools?.length ?? 0) + (p.aiTools?.length ?? 0) > 0;
    return { name: p.name, description: p.description, keys: bound.map((b) => b.key).join(' '), tools };
  });
  const nameW = Math.max(0, ...guests.map((g) => g.name.length));
  const keyW = Math.max(0, ...guests.map((g) => Array.from(g.keys).length));
  // As wide as the longest description needs, within what the screen leaves and a
  // measure that still reads as a list (not a paragraph across the terminal).
  const longest = Math.max(0, ...guests.map((g) => Array.from(g.description ?? 'tools for the assistant').length));
  const descW = Math.max(16, Math.min(longest, 56, width - nameW - keyW - 12));

  // Centred on the screen as ONE block; inside it the rows keep a common left edge,
  // so the column of keys reads as a column.
  return h(Box, { flexGrow: 1, width: '100%', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' },
    h(Box, { flexDirection: 'column', gap: 1 },
    h(Box, { flexDirection: 'row', gap: 3 },
      h(Box, { flexDirection: 'column', flexShrink: 0 }, LOGO.map((row, i) => h(Text, { key: i, bold: true, color: accent }, row))),
      h(Box, { flexDirection: 'column', justifyContent: 'center' },
        h(Text, { bold: true }, title),
        h(Text, { dim: true }, 'an assistant in your terminal'))),
    h(Box, { flexDirection: 'column' },
      doors.map(([key, label]) => h(Box, { key: label, flexDirection: 'row' },
        h(Text, { bold: true, color: accent }, key.padEnd(pad + 2)),
        h(Text, null, label)))),
    guests.length
      ? h(Box, { flexDirection: 'column' },
          h(Text, { dim: true }, 'plugins'),
          guests.map((g) => h(Box, { key: g.name, flexDirection: 'row' },
            // Three columns — name, the key that leads in, what it is — each padded to
            // its widest cell, so the descriptions start on one vertical line.
            h(Text, null, `  ${g.name.padEnd(nameW)}`),
            keyW ? h(Text, { bold: true, color: accent }, `  ${g.keys.padEnd(keyW)}`) : null,
            // A long description WRAPS inside its column, so its next line starts under
            // its first — it neither runs off the screen nor stretches the block.
            h(Box, { width: descW, marginLeft: 2, flexShrink: 0 },
              h(Text, { dim: true, wrap: 'wrap' }, g.description ?? (g.tools ? 'tools for the assistant' : ''))))))
      : pluginsNote
        ? h(Box, { flexDirection: 'column' },
            h(Text, { dim: true }, 'plugins'),
            // A path can be longer than the screen; it wraps rather than running off.
            h(Box, { width: Math.min(Array.from(pluginsNote).length, Math.max(16, width - 6)), marginLeft: 2, flexShrink: 0 },
              h(Text, { dim: true, wrap: 'wrap' }, pluginsNote)))
        : null));
}
