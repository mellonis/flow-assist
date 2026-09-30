// The list as it stands (`Conversation.currentRows`): as the chat last drew it while a
// port draws the conversation, its own list with none — the drawn list stopped when the
// port left. A save writes it, and the project's instructions are said once against it
// (AGENTS.md (sessions survive a restart)).
import { expect, test } from 'bun:test';
import { Conversation } from '../conversation.ts';
import { snapshotSession } from '../conversation-session.ts';
import type { JournalEvent } from '../journal.ts';
import type { ViewPort } from '../conversation-types.ts';
import { fakeDeps } from './conversation-deps.ts';

const NOTE = 'Project instructions: AGENTS.md';
const port: ViewPort = { showsEnd: () => true, open: () => true, input: () => '', draft: () => '' };

// A conversation whose drawn list ends in the note and whose own list does not, with
// what it journals caught.
function drawnAhead() {
  const c = new Conversation(fakeDeps());
  const lines: JournalEvent[] = [];
  c.journal = (ev: JournalEvent) => { lines.push(ev); return ''; };
  c.drawnRows = [{ role: 'note', content: NOTE }];
  return { c, lines };
}

test('with no port, the note is said and journaled though a stale drawn list ends in it', () => {
  const { c, lines } = drawnAhead();
  c.pushProjectNote(NOTE);
  expect(lines).toEqual([{ t: 'row', role: 'note', text: NOTE }]);
  expect(c.messages.at(-1)).toEqual({ role: 'note', content: NOTE });
});

test('with a port, the drawn list is what was said: a note it ends in is not journaled again', () => {
  const { c, lines } = drawnAhead();
  c.attach(port);
  c.pushProjectNote(NOTE);
  expect(lines).toEqual([]);
});

test('a save of a conversation a port draws writes the list as drawn, not its own', () => {
  const c = new Conversation(fakeDeps());
  c.setRows([{ role: 'user', content: 'asked' }]);
  const drawn = c.messages;
  c.setRows((cur) => [...cur, { role: 'bg', content: 'not drawn yet' }]);
  c.attach(port);
  c.drawnRows = drawn;
  expect(snapshotSession(c).messages).toEqual([{ role: 'user', content: 'asked' }]);
});
