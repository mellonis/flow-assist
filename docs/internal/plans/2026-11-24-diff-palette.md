# The same diff in the chat and in `/diff` — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a change block in the conversation, a diff the model writes in an answer, and the `/diff` panel draw `+` and `-` rows with the same ink and the same band, from the chat palette, on every colour scheme.

**Architecture:** two palette keys per meaning (`add`/`del` and their grounds `addBg`/`delBg`) are added to the chat palette; the chat hands them to flowtty as `tokenColors` (the option `@flowtty/react@1.0.0-alpha.40` adds), and the panel draws them itself, its band a `flexGrow: 1` Box beside the number gutter. `warn` goes back to meaning only "waits on the person".

**Tech Stack:** TypeScript 7, Bun 1.4 (`bun test`), React 19, `@flowtty/react@1.0.0-alpha.40`.

**Spec:** `../flowtty/docs/internal/plans/markdown-token-colors-design.md` (from the host root)

## Global Constraints

- A diff row is coloured by what it does: `add` for what came in, `del` for what went out — in all three views, `warn` never.
- Every new colour exists in all three palettes (`MODAL_COLOR_DEFAULTS`, `LIGHT_MODAL_COLORS`, the unknown scheme), as `askBg`/`askInk` do, and is overridable through `config.plugins.chat.colors`.
- A band the palette does not name is left unnamed: `background: undefined` in a spread erases flowtty's default band, so styles are built field by field.
- The panel's band never covers the number gutter and is never padded spaces: a drag over a diff row copies the code alone.
- Comments describe the code as it is; no history, no "now".
- `bun run typecheck && bun test ./src ./scripts ./packages` from the host root before every commit.

## Review Focus

- A palette missing the new keys (a test's partial `palette`, a plugin modal's own object) — nothing is painted as `undefined`, nothing throws; the row is simply unbanded.
- The person's own `config.plugins.chat.colors.del` / `delBg` — both views obey it, with no value baked into a renderer.
- A light terminal — the band is pale and the ink dark enough to read on it (the shipped `#3b0000` under black-on-light is what this fixes).
- A diff in a folded stretch, opened with `^o` — the block's rows are the same rows, palette included.
- `/diff` in `side` mode on a narrow terminal — the band still ends at the panel's inner edge, not at the text.

---

## File Structure

```
src/playback/theme.ts                     the four keys, three schemes + the palette comment
src/playback/__tests__/theme.test.ts      they land in every scheme, the override reaches them
src/views/modals.ts                       chatMarkdownOptions, mdLines/changeLines/blockLines, the panel
src/views/__tests__/modals.test.ts        the three views agree
package.json, bun.lock                    @flowtty/* at ^1.0.0-alpha.40
CHANGELOG.md                              one Unreleased entry
```

---

### Task 1: The dependency

**Files:**
- Modify: `package.json:21-23`
- Modify: `bun.lock` (through `bun install`)

**Interfaces:**
- Consumes: `@flowtty/react@1.0.0-alpha.40` published by the flowtty plan.
- Produces: `MarkdownOptions.tokenColors` and `MarkdownTokenColors` available to later tasks.

- [ ] **Step 1: Bump the three packages**

`"@flowtty/core": "^1.0.0-alpha.40"`, `"@flowtty/react": "^1.0.0-alpha.40"`,
`"@flowtty/tty-backend": "^1.0.0-alpha.40"`.

- [ ] **Step 2: Install and verify the option is there**

Run: `bun install`
Run: `rg -n "tokenColors" node_modules/@flowtty/react/dist/index.d.ts`
Expected: the `MarkdownOptions.tokenColors` declaration is found.

- [ ] **Step 3: Typecheck and test**

Run: `bun run typecheck && bun test ./src ./scripts ./packages`
Expected: green — the bump changes no behaviour.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: @flowtty/* 1.0.0-alpha.40"
```

---

### Task 2: Two inks and two grounds in the chat palette

**Files:**
- Modify: `src/playback/theme.ts:159` (`MODAL_COLOR_DEFAULTS.chat`), `:169` (`LIGHT_MODAL_COLORS.chat`), the palette comment above them
- Test: `src/playback/__tests__/theme.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `theme.modals.chat.add`, `.del`, `.addBg`, `.delBg` — read by Task 3 (the chat) and Task 4 (the panel).

- [ ] **Step 1: Write the failing test**

Mirror the file's `askBg` test (`modalsOf` is already there):

```ts
// A diff's two inks and the grounds they sit on are the palette's, in every scheme:
// the chat block and the panel must not fall back to a literal of their own.
test('the diff inks and their bands land in every palette', () => {
  for (const scheme of ['light', 'dark', 'unknown'] as const) {
    const chat = modalColorDefaults(scheme).chat;
    for (const key of ['add', 'del', 'addBg', 'delBg'] as const) expect(chat[key]).toBeString();
  }
  const light = modalsOf(resolveAppTheme(undefined, [], {}, 'light')).chat;
  const dark = modalsOf(resolveAppTheme(undefined, [], {}, 'dark')).chat;
  // A deletion is not a warning: the two are told apart in both schemes.
  expect(light.del).not.toBe(light.warn);
  expect(dark.del).not.toBe(dark.warn);
  // A pale band under dark ink on a light terminal, a dark one under bright ink.
  expect(light.delBg).not.toBe(dark.delBg);
  expect(light.del).not.toBe(light.delBg);
  expect(dark.del).not.toBe(dark.delBg);
  // The person's own palette reaches them like every other chat colour.
  const mine = resolveAppTheme(undefined, [], { plugins: { chat: { colors: { del: 'blue', delBg: 'black' } } } }, 'light');
  expect(modalsOf(mine).chat.del).toBe('blue');
  expect(modalsOf(mine).chat.delBg).toBe('black');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/playback/__tests__/theme.test.ts`
Expected: FAIL — `chat.add` is `undefined`.

- [ ] **Step 3: Add the keys**

`MODAL_COLOR_DEFAULTS.chat`: `add: 'green'`, `del: 'red'`, `addBg: '#003b00'`, `delBg: '#3b0000'`.
`LIGHT_MODAL_COLORS.chat`: `add: 'green'`, `del: '#a40000'`, `addBg: '#e6f4e6'`, `delBg: '#fce8e8'`.
The unknown scheme spreads `MODAL_COLOR_DEFAULTS.chat`, so it needs one change only:
`addBg: 'default'`, `delBg: 'default'` — `default` is flowtty's "no background" sentinel,
which is why a band on a terminal whose scheme nobody knows is simply not drawn.

Extend the palette comment (`src/playback/theme.ts:139-158`) with the four:
`add`/`del` — what a diff row brought in / took out, in the chat block, a diff the model
writes, and the `/diff` panel; `addBg`/`delBg` — the ground those rows sit on.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/playback/__tests__/theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/playback/theme.ts src/playback/__tests__/theme.test.ts
git commit -m "feat(theme): the chat palette carries the diff's inks and bands"
```

---

### Task 3: The chat's diffs take the palette

**Files:**
- Modify: `src/views/modals.ts:318-330` (`mdLines`), `:352-372` (`blockLines`), `:378-400` (`changeLines`), the seven `mdLines(...)` call sites in `rowsPerDrawn`, `:1340` (`changeLines`)
- Test: `src/views/__tests__/modals.test.ts`

**Interfaces:**
- Consumes: `add`/`del`/`addBg`/`delBg` from Task 2; `MarkdownOptions.tokenColors` from Task 1.
- Produces:
  - `chatMarkdownOptions(m: Record<string, string | undefined>): MarkdownOptions`
  - `mdLines(text: string | null | undefined, wrap: number, palette?: Record<string, string | undefined>): Line[]`
  - `changeLines(v: ChangeView, inner: number, palette?: Record<string, string | undefined>): Line[]`
  - `blockLines(md: string, width: number, palette?: Record<string, string | undefined>): { lines: Line[]; src: number[] }`

- [ ] **Step 1: Write the failing test**

```ts
// One palette for a diff wherever the chat draws it: the `✎` block of a write and a
// ```diff fence in an answer take the chat's own `add`/`del` and their grounds.
test('a change block and a diff the model writes take the chat palette', async () => {
  const chat = { ...MODAL_COLOR_DEFAULTS.chat, add: 'greenBright', del: 'redBright', addBg: '#123456', delBg: '#654321' };
  const messages = [{
    role: 'assistant',
    content: 'Here:\n```diff\n-old\n+new\n```',
    parts: [{ kind: 'change', change: { title: 'src/a.ts', diff: '@@ -1,1 +1,1 @@\n-a\n+b', added: 1, removed: 1, hidden: 0 } }],
  }];
  const backend = new TestBackend(80, 24);
  const handle = await render(h(renderChatModal, { ...baseChat, theme: { modals: { chat } }, messages: messages as never }), backend);
  const lines = backend.lastFrame.split('\n');
  const styleAt = (needle: string, nth = 0) => {
    const ys = lines.map((r, y) => (r.includes(needle) ? y : -1)).filter((y) => y >= 0);
    const y = ys[nth]!;
    return backend.lastBuffer!.get(lines[y]!.indexOf(needle), y).style;
  };
  // The write's own block …
  expect(styleAt('-a')).toMatchObject({ fg: 'redBright', bg: '#654321' });
  expect(styleAt('+b')).toMatchObject({ fg: 'greenBright', bg: '#123456' });
  // … and the fence the model wrote, which is laid out by the same helper.
  expect(styleAt('-old')).toMatchObject({ fg: 'redBright', bg: '#654321' });
  expect(styleAt('+new')).toMatchObject({ fg: 'greenBright', bg: '#123456' });
  handle.unmount();
});

// Review Focus: a palette that names no band draws no band and never an `undefined`
// — the ink is still the palette's.
test('a palette without bands draws no band, and the ink is the palette\'s', async () => {
  const chat = { ...MODAL_COLOR_DEFAULTS.chat, add: 'blue', del: 'magenta', addBg: undefined, delBg: undefined };
  const messages = [{ role: 'assistant', content: 'x', parts: [{ kind: 'change', change: { title: 'a', diff: '@@ -1 +1 @@\n-a\n+b', added: 1, removed: 1, hidden: 0 } }] }];
  const backend = new TestBackend(80, 24);
  const handle = await render(h(renderChatModal, { ...baseChat, theme: { modals: { chat } }, messages: messages as never }), backend);
  const rows = backend.lastFrame.split('\n');
  const y = rows.findIndex((r) => r.includes('-a'));
  const style = backend.lastBuffer!.get(rows[y]!.indexOf('-a'), y).style;
  expect(style.fg).toBe('magenta');
  // `default` is flowtty's "no background" sentinel — the writer drops it. Never the
  // layout's dark fallback under the chat's ink, and never the panel's ground.
  expect([undefined, 'default']).toContain(style.bg);
  expect(style.bg).not.toBe('#3b0000');
  handle.unmount();
});

// Review Focus: a change block inside a stretch opened with `^o` is the same rows —
// the fold is a filter over the rows the palette already painted.
test('a change block in an opened stretch takes the same palette', () => {
  const chat = { ...MODAL_COLOR_DEFAULTS.chat, add: 'greenBright', del: 'redBright', addBg: '#123456', delBg: '#654321' };
  const changed = {
    role: 'assistant', content: '',
    parts: [
      { kind: 'tools', runs: [{ name: 'git_status', outcome: 'ok' }] },
      { kind: 'change', change: { title: 'src/a.ts', diff: '@@ -1,1 +1,1 @@\n-a\n+b', added: 1, removed: 1, hidden: 0 } },
    ],
  };
  const rows = chatRows([changed] as never, { ...groupOpts(), notes: 'open', palette: chat });
  const spans = rows.flatMap((r) => r.spans);
  expect(spans.find((s) => s.text === '-a')).toMatchObject({ color: 'redBright', background: '#654321' });
  expect(spans.find((s) => s.text === '+b')).toMatchObject({ color: 'greenBright', background: '#123456' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/views/__tests__/modals.test.ts -t "palette"`
Expected: FAIL — the rows are `red`/`green` with flowtty's bands.

- [ ] **Step 3: Implement**

In `src/views/modals.ts`, above `mdLines`:

```ts
// What a diff is drawn with in the chat: the palette's own inks and grounds, so the
// `✎` block, a fence the model wrote and the `/diff` panel read alike. A style is
// built field by field — `background: undefined` in a spread would erase flowtty's
// default band, which is the opposite of a palette that names none.
export function chatMarkdownOptions(m: Record<string, string | undefined>): MarkdownOptions {
  const style = (ink?: string, band?: string) => ({
    ...(ink === undefined ? {} : { color: ink }),
    ...(band === undefined ? {} : { background: band }),
  });
  return {
    tokenColors: {
      added: style(m.add, m.addBg),
      removed: style(m.del, m.delBg),
      ...(m.accent === undefined ? {} : { hunk: m.accent }),
    },
  };
}
```

`mdLines(text, wrap, palette?)` calls `layoutMarkdown(text, wrap, palette ? chatMarkdownOptions(palette) : undefined)`;
`blockLines(md, width, palette?)` passes the same options to `layoutMarkdownDetailed`;
`changeLines(v, inner, palette?)` hands its palette to `blockLines`.

At every `mdLines(...)` and `changeLines(...)` call inside `rowsPerDrawn` (the seven
`mdLines` sites at 1277, 1331, 1381, 1404, 1418, 1432, 1453 — every one of them — and
`changeLines` at 1340), pass `o.palette` as the last argument. `mdLines` keeps working
without a palette for its other callers (tests, `chatRows` without one).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/views/__tests__/modals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/modals.ts src/views/__tests__/modals.test.ts
git commit -m "feat(chat): a diff's inks and bands come from the chat palette"
```

---

### Task 4: The `/diff` panel draws `del`, and wears the band

**Files:**
- Modify: `src/views/modals.ts:3297-3312` (`diffPanelBody`'s hunk rows)
- Test: `src/views/__tests__/modals.test.ts:2232-2254` (update), plus a new band test

**Interfaces:**
- Consumes: `add`/`del`/`addBg`/`delBg` (Task 2); `p.palette` already reaches `diffPanelBody`.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing test**

Update the existing panel test's palette and expectations:

```ts
palette: { accent: 'cyan', add: 'green', del: 'red', addBg: '#003b00', delBg: '#3b0000' },
// …
expect(fgAt('+here')).toBe('green');
expect(fgAt('-gone')).toBe('red');
```

Add:

```ts
// The band is the palette's and covers the code area only: the number gutter keeps the
// panel's own ground, and the band runs to the panel's right edge rather than stopping
// at the end of the text — so a drag over the row still copies the code alone.
test('a diff row wears the palette band across the code area, never over the gutter', async () => {
  const section: DiffSection = {
    root: '/r',
    files: [{ status: 'M', path: 'a.txt', added: 1, removed: 1, hunks: '@@ -1 +1 @@\n-one\n+two' }],
  };
  const drawn = await diffFrame({
    sections: [section], collapsed: new Set(), cursor: null,
    palette: { bg: 'black', add: 'green', del: 'red', addBg: '#003b00', delBg: '#3b0000' },
  });
  const rows = drawn.frame.split('\n');
  const y = rows.findIndex((r) => r.includes('-one'));
  const x = rows[y]!.indexOf('-one');
  const at = (col: number) => drawn.backend.lastBuffer!.get(col, y).style;
  expect(at(x).bg).toBe('#3b0000');
  expect(at(x + 20).bg).toBe('#3b0000'); // well past the text
  expect(at(2).bg).toBe('black');        // the file's line number is the panel's ground
  const drag = drawn.handle.select({ x: 2, y }, { x: 60, y });
  expect(drag).toContain('-one');
  expect(drag).not.toContain('1');
  drawn.handle.unmount();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/views/__tests__/modals.test.ts -t "diff"`
Expected: FAIL — `-gone` is `yellow`, and no cell carries `#3b0000`.

- [ ] **Step 3: Implement**

In the hunk-row loop:

```ts
const band = r.text.startsWith('+') ? m.addBg : r.text.startsWith('-') ? m.delBg : undefined;
const color = r.text.startsWith('+') ? m.add : r.text.startsWith('-') ? m.del : undefined;
const code = changed
  ? h(Text, { color, wrap: 'truncate' }, r.text)
  : h(Text, { dim: true, wrap: 'truncate' }, r.text);
rows.push(h(Box, { key: `h${si}-${fi}-${ri}`, flexDirection: 'row', flexShrink: 0, ...fold },
  h(Text, { dim: true, selectable: false, wrap: 'truncate' }, `${r.no.padStart(width)} `),
  band === undefined ? code : h(Box, { flexGrow: 1, backgroundColor: band }, code)));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/views/__tests__/modals.test.ts`
Expected: PASS.

- [ ] **Step 5: Changelog and the whole suite**

Under `## Unreleased` in `CHANGELOG.md`, one entry:

```markdown
- **A diff reads the same in the chat and in `/diff`.** A removed line was amber in the
  panel — `warn`, the colour of what waits on you — and red in the change block, so the
  same file told two stories. Both now take the chat palette's `del` and its ground
  `delBg` (`add`/`addBg` for what came in), and so does a ```diff the assistant writes
  in an answer; the bands sit under the same inks in all three places and follow the
  terminal's scheme. `warn` is again only what waits on the person.
```

Run: `bun run typecheck && bun test ./src ./scripts ./packages`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/views/modals.ts src/views/__tests__/modals.test.ts CHANGELOG.md
git commit -m "feat(diff): one palette for the chat's diffs and /diff"
```
