// Whether a question block is UP and taking the keys.
//
// Once the person answers one — or dismisses it — the block STAYS in the chat as a row
// of its own: the question, with the answer under it (`→ master`, `→ dismissed`). So the
// question's text says nothing about what is waiting; its hint row does, because only
// the live block draws one. A test that waits for the question to go away waits for
// `askUp` to turn false.
//
// It reads the whole frame, so it cannot say WHICH block drew the hint: with a
// subagent's question drawn under the session's answered one, `askUp` is true because of
// the subagent's block. A test about one particular block matches that block's own rows
// (its option list, its title) instead.
const LIVE_HINTS = ['type your own words', '⏎ submit · '];

export const askUp = (frame: string): boolean => LIVE_HINTS.some((h) => frame.includes(h));
