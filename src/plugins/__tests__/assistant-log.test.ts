import { expect, test } from 'bun:test';
import { logShareMessage, LOG_SHARE_DEFAULT, LOG_SHARE_MAX } from '../assistant';

const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);

test('/log shares the TAIL of the host log as the person\'s own message', () => {
  const msg = logShareMessage(lines)!;
  expect(msg.startsWith(`Host log, last ${LOG_SHARE_DEFAULT} lines:`)).toBe(true);
  expect(msg).toContain('line 500');
  expect(msg).toContain(`line ${500 - LOG_SHARE_DEFAULT + 1}`);
  expect(msg).not.toContain(`line ${500 - LOG_SHARE_DEFAULT}\n`);
  expect(logShareMessage(lines, '3')!.split('\n').slice(2, 5)).toEqual(['line 498', 'line 499', 'line 500']);
  expect(logShareMessage(['only'], '5')).toContain('last 1 line:');
});

test('/log caps the share and refuses an empty log', () => {
  expect(logShareMessage(lines, '99999')!.split('\n')).toHaveLength(LOG_SHARE_MAX + 3);
  // A junk or non-positive count falls back to the default rather than sharing everything.
  for (const junk of ['abc', '0', '-7']) expect(logShareMessage(lines, junk)!.startsWith(`Host log, last ${LOG_SHARE_DEFAULT} lines:`)).toBe(true);
  expect(logShareMessage([])).toBeNull();
});
