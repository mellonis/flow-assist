# Theme is a key — `/theme` goes, the host takes the palette

**Goal.** Two things, one after the other:

1. **The chat loses `/theme`.** The look is `ui.theme`, set on the `:` line
   (`:config set ui.theme dark`), which is validated, completed and applied live
   already (`src/config/schema.ts:160`, `src/config/commands.ts` completion). No host
   twin either — decided: `:theme` would be sugar over `config set` with no menu to
   justify it.
2. **The host's own screen takes the palette.** Today `ui.theme` repaints the chat
   window and the panels over it only; the screen around them keeps the terminal's
   ground and ink, so `dark` on a light terminal leaves a bright frame. Proven on the
   real harness: with `ui.theme dark` the chat's hint cell is
   `{ bg: 'black', fg: 'white' }` and a host cell (the `: commands — try :help` row's
   left padding) is `{}`.

**Why the host stays light (the fact this plan fixes).** The host's side of the screen
is drawn in `src/runtime/app.tsx` from ~1403 (`h(Box, { flexDirection: 'column', width:
region.width, … })`) and reads no palette: no `backgroundColor`, no `color`. The only
consumers of `config.theme` outside `src/views/modals.ts` (the chat/panel window) are
the chat accent (`chatAccent`, app.tsx:1323) and `renderCommandPanel`. Accents that are
painted are literals: the `: ` prompt is `color: 'cyan'` (app.tsx:1441, and the two
ghost cells at 1448), and `renderHome` defaults `accent = 'green'` and is called without
one (app.tsx:1420).

**Out of scope.** The chat's own palette (`theme.modals.chat`) and `theme` the record
(a person's colours) are untouched. `host.services.setThemeMode` stays: it is the
plugin-facing channel (`docs/plugins.md:515`) and `theme-mode.e2e.test.ts` drives it.
No version bump — both changes land under `## Unreleased`.

---

## Task 1 — the chat loses `/theme`

### Step 1: RED — a test that the door is gone

In `src/__tests__/theme-mode.e2e.test.ts`, append (it already has `bootApp`, `settle`,
`resetSessionConfig`, and reads `ui.backend.lastFrame` inline):

```ts
test('/theme is gone — the look is a config key', async () => {
  const ui = await bootApp(new ScriptedModel(), 100, 30, undefined, {}, { scheme: 'unknown' });
  await ui.press('F');
  await settle();
  await ui.type('/theme dark');
  await ui.press('return');
  await settle();
  // The chat says the command is not there, and the list it names does not offer it.
  expect(ui.backend.lastFrame).toContain('unknown command /theme');
  expect(ui.backend.lastFrame).not.toContain('/theme,');
  // Nothing was applied by the refused line: the terminal still has the say.
  expect(NONE).toContain(hintCell(ui).bg);
  ui.app.unmount();
});
```

`hintCell` exists in that file; add `const NONE = [undefined, 'default'];` beside the
other constants at the top (the file already imports `expect`).

### Step 2: run it and see it fail

```sh
bun test src/__tests__/theme-mode.e2e.test.ts
```

Expected: FAIL — `/theme dark` still works, so the frame has no `unknown command
/theme` (and says `theme: dark` instead).

### Step 3: take the command out

1. `src/plugins/assistant.ts` — delete the whole `case 'theme': { … }` block, lines
   **2097–2150** (`case 'log'` starts at 2151). Nothing else in the switch moves.
2. `src/plugins/assistant.ts` — delete the command's entry and its two-line comment,
   lines **131–133**:

   ```ts
   // A chosen theme is not worth recalling: the menu is one key away and ↑/↓ history is
   // for the command's argument.
   { name: 'theme', description: 'the look: system, light or dark', values: THEME_MODES, history: false },
   ```

3. `src/plugins/assistant.ts` — line **83** loses the import (checked: `THEME_MODES`,
   `parseThemeArg` and `ThemeMode` are used nowhere else in the file):

   ```ts
   import { THEME_MODES, parseThemeArg, type ThemeMode } from '../playback/theme-mode.js';
   ```

4. `src/playback/theme-mode.ts` — delete `THEME_MODES` and `parseThemeArg` (both lines
   12–21). The module keeps `ThemeMode` and `schemeFor`; its header comment stays true.
   The one list of the three words is the schema's `z.enum(['system', 'light',
   'dark'])` at `src/config/schema.ts:160`, which is what `config set` validates and
   completes against.
5. `src/playback/__tests__/theme-mode.test.ts` — the import becomes
   `import { schemeFor } from '../theme-mode';` and the `parseThemeArg takes the three
   words…` test (lines 14–21) goes with the function.
6. Delete `src/__tests__/theme-command.e2e.test.ts` — every test in it is the panel,
   the preview, the argument or the drop, all of which are gone; the live-repaint path
   it also covered stays covered by `theme-mode.e2e.test.ts`.

### Step 4: run green

```sh
bun test src/__tests__/theme-mode.e2e.test.ts src/playback/__tests__/theme-mode.test.ts
bun run typecheck
```

Expected: pass; typecheck clean (a leftover import would fail here).

### Step 5: docs, same commit

`docs/usage.md` — replace the whole `## The look: `/theme`` section (lines 951–975) with:

```md
## The look

`ui.theme` is the app's appearance: `system` (the default) follows the terminal's own
light/dark scheme as it changes — macOS switches by itself and the terminal follows —
while `light` and `dark` pin one whatever the terminal says. It is set on the `:` line:

    :config set ui.theme dark

and it is read live: the screen repaints at once, the host's own side and the chat
alike. `:config unset ui.theme` follows the terminal again, and `:config get ui.theme`
says what is in force. A value written into `config.local.json` from outside a running
app is read at the next start — there is no file watcher.

The setting is the person's: it has no mark for the assistant. A palette of your own is
still `theme` (`config set theme …`), which lays its colours over either scheme — see
[config.md](config.md).
```

Check the table of contents near the top of `docs/usage.md` for a `#the-look-theme`
anchor and point it at `#the-look`.

`docs/config.md` — in the `**The look**` bullet (lines 24–29) drop the `/theme`
sentences and say:

```md
  read live: `:config set ui.theme dark` in the running app repaints it at once — the
  host's own side and the chat alike; a value written into `config.local.json` from
  outside a running app is read at the next start — there is no file watcher. See
  [usage.md](usage.md), "The look". The key is the person's — the assistant has no mark
  for it.
```

`CHANGELOG.md` — under `## Unreleased`, first entry:

```md
- **`/theme` is gone: the look is a config key.** `ui.theme` (`system`, `light`, `dark`)
  is set on the `:` line — `:config set ui.theme dark` — and read live, so the screen
  repaints at once; `:config unset ui.theme` follows the terminal again. The chat's menu
  with the palette previewed as the cursor moved went with the command.
```

### Step 6: commit

```sh
git add -A
git commit -m "refactor: /theme goes — the look is ui.theme on the : line"
```

---

## Task 2 — the host's own screen takes the palette

### Step 1: RED — a test of the host's ground and ink

New file `src/__tests__/theme-host.e2e.test.ts`:

```ts
// `ui.theme` is the whole screen's appearance, not the chat window's: the host's own
// side — the start screen, the `: ` line, the hint row — takes the palette's base
// ground and ink too. What a person sees is a cell with no colour of its own, so it
// shows what the screen gives it (the cell-style idiom of color-scheme.e2e).
import { afterEach, expect, test } from 'bun:test';
import { ScriptedModel, bootApp, settle } from './helpers/scripted';
import { resetSessionConfig } from '../config/load';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetSessionConfig(); });

type Ui = Awaited<ReturnType<typeof bootApp>>;
const NONE = [undefined, 'default'];

// A cell of the host's own side: the hint row's left padding, beside `: commands`.
const hostCell = (ui: Ui) => {
  const rows = ui.backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes('commands — try :help'));
  expect(y).toBeGreaterThanOrEqual(0);
  return { x: 1, y, style: ui.backend.lastBuffer!.get(1, y).style as { fg?: string; bg?: string } };
};

async function command(ui: Ui, line: string) {
  await ui.press(':');
  await ui.type(line);
  await ui.press('return');
  await settle();
}

test('the host’s own screen takes the theme', async () => {
  const ui = await bootApp(new ScriptedModel(), 120, 40, undefined, {}, { scheme: 'unknown' });
  // The terminal has not said: no ground and no ink of the app's own.
  expect(NONE).toContain(hostCell(ui).style.bg);
  expect(hostCell(ui).style.fg).toBeUndefined();

  // A pinned mode paints the host's side at once, and the ink with it.
  await command(ui, 'config set --session ui.theme dark');
  expect(hostCell(ui).style).toMatchObject({ bg: 'black', fg: 'white' });
  await command(ui, 'config set --session ui.theme light');
  expect(hostCell(ui).style).toMatchObject({ bg: '#f4f4f6', fg: 'black' });

  // `system` gives the terminal the say again — here it never said, so nothing is left.
  await command(ui, 'config set --session ui.theme system');
  expect(NONE).toContain(hostCell(ui).style.bg);
  expect(hostCell(ui).style.fg).toBeUndefined();
  ui.app.unmount();
});

test('the command prompt takes the palette’s border colour, not a literal', async () => {
  const ui = await bootApp(new ScriptedModel(), 120, 40, undefined, {}, { scheme: 'unknown' });
  await command(ui, 'config set --session ui.theme light');
  await ui.press(':');
  await settle();
  const rows = ui.backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.trimStart().startsWith(': '));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = rows[y]!.indexOf(': ');
  // The light palette's border is blue; the dark and unknown ones are cyan.
  expect(ui.backend.lastBuffer!.get(x, y).style.fg).toBe('blue');
  await ui.press('escape');
  ui.app.unmount();
});
```

### Step 2: run it and see it fail

```sh
bun test src/__tests__/theme-host.e2e.test.ts
```

Expected: FAIL on `{ bg: 'black', fg: 'white' }` (the cell is `{}`), and on the prompt's
`'blue'` (it is `'cyan'`).

### Step 3: the palette, and the two places that read it

`src/playback/theme.ts` — below `resolveAppTheme`, add:

```ts
// The ABSTRACT base (`modals`' flat props), as the host's own screen reads it — the
// start screen, the title bar, the `: ` line and the hint row are not a modal, so
// nothing but this gave them a ground and an ink. A value the palette leaves to the
// terminal (`default`: the scheme unknown, or a person's own `default`) is `undefined`,
// so nothing is painted over the terminal's own colours.
export interface BaseInk { bg?: string; text?: string; border?: string; selected?: string }

export function baseInk(theme: Theme | undefined): BaseInk {
  const base = (theme?.modals ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = base[key];
    return typeof value === 'string' && value !== 'default' ? value : undefined;
  };
  return { bg: pick('bg'), text: pick('text'), border: pick('border'), selected: pick('selected') };
}
```

`src/runtime/app.tsx`:

1. Beside `chatAccent` (line 1323):

   ```ts
   const base = baseInk(config.theme as Theme | undefined);
   ```

   and import `baseInk` from `../playback/theme.js` (line 63's import list).

2. The host's side of the screen (line 1403) takes the ground and the ink — every
   cell inside it that names no colour of its own now shows these, the start screen and
   the footer included; the chat window has its own palette and is outside this box:

   ```ts
   h(Box, { flexDirection: 'column', width: region.width, height: region.height, flexShrink: 0, overflow: 'hidden', selectionScope: true,
     ...(base.bg ? { backgroundColor: base.bg } : {}), ...(base.text ? { color: base.text } : {}) },
   ```

3. The `: ` prompt and its offer take the palette's border instead of the literal
   (lines 1441 and 1448 — three `color: 'cyan'` in all):

   ```ts
   h(Text, { bold: true, color: base.border ?? 'cyan', selectable: false }, ': '),
   …
   h(Text, { key: 'g0', inverse: true, dim: true, color: base.border ?? 'cyan', selectable: false }, line.ghost[0]),
   h(Text, { key: 'g1', dim: true, color: base.border ?? 'cyan', selectable: false }, line.ghost.slice(1))
   ```

4. The start screen's keys take the palette's `selected` instead of the default
   (line 1420):

   ```ts
   atHome ? renderHome({ title, plugins, keys, builtins: BUILTIN_PLUGINS, width: region.width, accent: base.selected ?? 'green', pluginsNote, starting: late?.starting(), untrusted, trustNotes }) : null),
   ```

Add a unit case to `src/playback/__tests__/theme.test.ts` (existing file):

```ts
test('baseInk leaves the terminal its own colours when the palette does', () => {
  expect(baseInk(UNKNOWN_THEME_LIKE)).toEqual({ bg: undefined, text: undefined, border: 'cyan', selected: 'green' });
});
```

Use the real palettes instead of a fixture: `baseInk(themeFor('unknown'))` for the
case above, `baseInk(themeFor('light'))` → `{ bg: '#f4f4f6', text: 'black', border:
'blue', selected: 'green' }`, `baseInk(themeFor('dark'))` → `{ bg: 'black', text:
'white', border: 'cyan', selected: 'green' }` (`themeFor` is exported from the module
under test).

### Step 4: run green

```sh
bun test src/__tests__/theme-host.e2e.test.ts src/__tests__/theme-mode.e2e.test.ts \
  src/__tests__/color-scheme.e2e.test.ts src/__tests__/copy.e2e.test.ts \
  src/__tests__/change-diff.e2e.test.ts src/playback/__tests__/theme.test.ts \
  src/views/__tests__/modals.test.ts
bun run typecheck
```

The last four are the suites that pin cell styles under a resolved scheme; they sample
the chat window's own palette, so they should not move. If one does, the failure is
about the host's side — fix the expectation only where it pinned the old, unthemed
ground.

### Step 5: docs and CHANGELOG, same commit

`CHANGELOG.md`, under `## Unreleased` (after the `/theme` entry):

```md
- **The host's own screen takes the theme.** `ui.theme` used to repaint the chat window
  and the panels over it; the screen around them — the start screen, the title bar, the
  `: ` line and the hint row — kept the terminal's ground and ink, so `dark` on a light
  terminal left a bright frame around a dark chat. The host's side now paints the
  palette's base ground and ink, and the `: ` prompt and the start screen's keys take
  the palette's colours instead of two literals. A person's own `theme` reaches the
  host's side too, for the same reason.
```

`docs/usage.md` — the `## The look` section written in Task 1 already claims the whole
screen repaints; nothing to change if the sentence is there. Check
`docs/config.md`'s chat-colours paragraph still says `theme.modals.chat` is the chat's
own — it does, and it is still true.

### Step 6: commit

```sh
git add -A
git commit -m "fix: the host's own screen takes the theme's ground and ink"
```

---

## Task 3 — the gate

```sh
bun run typecheck
bun test 2>&1 | tee "$TMPDIR/theme-suite.log"
```

Verdict rule: every failing test NAME must be in the known pool (the three reproducible
ones plus the validated timing/mcp flakes). A name outside the pool is a regression from
this change — start from the diff, not from a re-run.

## Task 4 — install the binary (after the gate is green)

```sh
bun run build:binary
cp ~/flow-assist/flow-assist ~/flow-assist/flow-assist.backup-$(date +%Y%m%d-%H%M%S)
mv dist/flow-assist ~/flow-assist/flow-assist
~/flow-assist/flow-assist --version
~/flow-assist/flow-assist config get ui.theme
```

Then, in the real terminal: `:config set ui.theme dark` on a light terminal — the
start screen and the frame around the chat must go dark with the chat, and
`:config set ui.theme system` must hand the screen back to the terminal.

## Trade-offs worth saying in the MR note

- **No `:theme`.** It would be sugar over `:config set ui.theme`, which already
  validates against the schema and completes the three words; the one thing it could
  add — a preview menu — was the chat command's, and that is the thing being removed.
  Precedent for such sugar exists (`:cache on|off`), but sugar still has to earn its
  line in `:help`.
- **The ground goes on the host's SIDE box, not the root.** The chat's window has its
  own palette and would only be painted twice; the floating layers (keycaps, the
  reminder) bring their own ground. The side box is exactly "the host's own screen", a
  guest plugin's surface included.
- **`'default'` becomes `undefined`, not a colour.** `default` is how the palette says
  "the terminal's" (the unknown scheme); passing it through as a colour would paint an
  explicit default where today there is none, and `color-scheme.e2e` holds the "until
  the terminal says, nothing of the app's own" contract.
- **`setThemeMode` stays.** It is documented for plugins (`docs/plugins.md`) and is the
  only programmatic way to pin the appearance for a run; the chat command was its
  caller, not its owner.
