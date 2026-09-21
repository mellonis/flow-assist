// The host's own start screen.
//
// flow-assist grew out of a tracker TUI, and for a long time still opened like one:
// every plugin component was mounted from the first frame, so the tracker plugin's
// board drew itself over an assistant that had not been asked for a board — and,
// with no board chosen, said "No board data". A plugin is a guest. Until the person
// opens something of its own, the screen is the HOST's: who this is, and what can be
// done from here.
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

interface HomePlugin { name: string; keys?: Record<string, unknown>; keyActions?: Record<string, unknown>; entry?: string[]; tools?: unknown[]; aiTools?: unknown[] }

export function renderHome({ title, plugins, keys, builtins, accent = 'green' }: {
  title: string;
  plugins: HomePlugin[];
  // The resolved key map — so what is shown is what is bound NOW.
  keys: Record<string, string[]>;
  // Names of the host's own plugins: they are the host, not something to list.
  builtins: string[];
  accent?: string;
}) {
  const cap = (action: string) => bindingGlyph(keys[action]);
  // What a person can do from here, each only if its key is bound.
  const doors: Array<[string, string]> = [
    [cap('chat'), 'talk to the assistant'],
    [cap('commandLine'), 'commands — try :help'],
    [cap('quit'), 'quit'],
  ].filter(([key]) => key) as Array<[string, string]>;
  const pad = Math.max(...doors.map(([key]) => Array.from(key).length), 1);

  // Guests: enabled plugins, and the keys each one binds — the way in to a plugin
  // that has a screen of its own. A tool-only plugin has none and is named as such.
  const guests = plugins.filter((p) => !builtins.includes(p.name)).map((p) => {
    // `entry` names the actions that lead INTO the plugin from here. Without it every
    // key the plugin binds is listed — honest, but it includes keys that only mean
    // something inside (a tracker's `filters` with no board open).
    const bound = (p.entry ?? Object.keys(p.keys ?? p.keyActions ?? {}))
      .map((action) => ({ action, key: cap(action) }))
      .filter((b) => b.key);
    const tools = (p.tools?.length ?? 0) + (p.aiTools?.length ?? 0) > 0;
    return { name: p.name, bound, tools };
  });

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
            h(Text, null, `  ${g.name}`),
            h(Text, { dim: true, wrap: 'truncate' }, g.bound.length
              ? `   ${g.bound.map((b) => `${b.key} ${b.action}`).join(' · ')}`
              : g.tools ? '   tools for the assistant' : ''))))
      : null));
}
