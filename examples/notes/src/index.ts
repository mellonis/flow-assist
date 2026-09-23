// A minimal flow-assist plugin: a notebook the assistant can read and add to.
// It has no screen of its own — only tools for the model and one `:` command —
// which is the smallest useful plugin (docs/plugins.md walks through it).
//
// Enable it with a link: `ln -s ../examples/notes plugins-enabled/notes`.
// The notebook is `notes.md` in the directory the app starts in, or the file
// set with `config set plugins.notes.file <path>`.
import fs from 'node:fs';
import path from 'node:path';

type Ctx = {
  reportChange?: (change: { title: string; before: string; after: string }) => void;
  reportView?: (kind: string, data: unknown) => void;
};

export default function buildNotesPlugin({ config, make, z }: any) {
  const file = (): string => config?.plugins?.notes?.file ?? path.join(process.cwd(), 'notes.md');
  const read = (): string => (fs.existsSync(file()) ? fs.readFileSync(file(), 'utf8') : '');

  return make('notes', {
    name: 'notes',
    // Validated by the host for `config set plugins.notes.<key>`.
    configSchema: z.object({ file: z.string().optional() }).optional(),

    // A tool group: what the model may call. A tool marked `write` makes the chat
    // pause for the person's y/n before it runs.
    tools: [{
      id: 'notes',
      tools: [
        {
          type: 'function',
          function: {
            name: 'notes_read',
            description: 'Read the notebook (a markdown list of notes).',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'notes_add',
            description: 'WRITE: add one note to the notebook. The person confirms it first.',
            parameters: { type: 'object', properties: { text: { type: 'string', description: 'The note.' } }, required: ['text'] },
          },
          write: true,
        },
      ],
      async exec(name: string, args: Record<string, unknown>, ctx: Ctx): Promise<string> {
        if (name === 'notes_read') return read() || '(the notebook is empty)';
        if (name === 'notes_add') {
          const text = String(args.text ?? '').trim();
          // A write refuses by throwing: whatever it returns counts as done.
          if (!text) throw new Error('text is required. Nothing was changed.');
          const before = read();
          const after = `${before}${before && !before.endsWith('\n') ? '\n' : ''}- ${text}\n`;
          fs.writeFileSync(file(), after);
          // What the write changed: the chat shows it as a diff; the model never gets it.
          ctx?.reportChange?.({ title: path.basename(file()), before, after });
          // A block of this plugin's own, drawn by `viewRenderers.note` below. Display
          // only — the model reads the returned text.
          ctx?.reportView?.('note', { text });
          return `Added to ${path.basename(file())}.`;
        }
        throw new Error(`Unknown tool: ${name}`);
      },
    }],

    // How this plugin's blocks are drawn: data in, lines of spans out. Colours are the
    // chat palette's tokens; the host cuts each line to the width.
    viewRenderers: {
      note: (data: { text?: string }) => [[{ text: '✎ ', color: 'accent' }, { text: `note: ${String(data?.text ?? '')}` }]],
    },

    // `:notes` — how many notes there are, in the host's message line.
    commands: [{
      name: 'notes',
      usage: 'notes',
      description: 'Count the notes in the notebook',
      run: (ctx: { showMessage?: (message: string) => void }) => {
        const count = read().split('\n').filter((line) => line.startsWith('- ')).length;
        ctx?.showMessage?.(`${count} note${count === 1 ? '' : 's'} in ${path.basename(file())}`);
      },
    }],
  });
}
