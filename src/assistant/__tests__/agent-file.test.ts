import { expect, test } from 'bun:test';
import { agentHash, fillPrompt, paramsText, parseAgentFile } from '../agent-file.ts';

const FULL = `---
description: Start a ticket from a title
params: ticket, branch?
tools: repo, gitlab
auto: reads
---
Open {{ticket}} and branch off {{branch}}.
A JSON example {"status": "ok"} keeps its braces.
`;
const P = '/x/agents/new-ticket.md';
const errorsOf = (text: string, file = P) => {
  const r = parseAgentFile(file, text);
  if (r.ok) throw new Error('parsed');
  return r.errors;
};

test('a full valid file is an agent with every field', () => {
  const r = parseAgentFile(P, FULL, { kind: 'project' });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.agent).toMatchObject({
    name: 'new-ticket',
    description: 'Start a ticket from a title',
    params: [{ name: 'ticket', optional: false }, { name: 'branch', optional: true }],
    tools: ['repo', 'gitlab'],
    auto: 'reads',
    path: P,
    source: { kind: 'project' },
  });
  expect(r.agent.body).toBe('Open {{ticket}} and branch off {{branch}}.\nA JSON example {"status": "ok"} keeps its braces.');
  expect(r.agent.hash).toMatch(/^[0-9a-f]{64}$/);
});

test('only the description is required; tools omitted is null, auto omitted is ask', () => {
  const r = parseAgentFile('/a/b.md', '---\ndescription: d\n---\nbody');
  expect(r.ok && r.agent).toMatchObject({ params: [], tools: null, auto: 'ask', body: 'body' });
  const empty = parseAgentFile('/a/b.md', '---\ndescription: d\ntools:\n---\nbody');
  expect(empty.ok && empty.agent.tools).toEqual([]);
});

test('each header error names the path and the 1-based line', () => {
  const at = (header: string, body = 'text') => errorsOf(`---\n${header}\n---\n${body}`);
  expect(at('description: d\ntool: x')).toEqual([{ path: P, line: 3, message: expect.stringContaining('unknown key "tool"') }]);
  expect(at('description: d\ndescription: e')[0]).toMatchObject({ line: 3, message: expect.stringContaining('duplicate key "description"') });
  expect(at('params: a', '{{a}}')[0]).toMatchObject({ line: 1, message: expect.stringContaining('missing key "description"') });
  expect(at('description:\n')[0]).toMatchObject({ line: 2, message: expect.stringContaining('empty') });
  expect(at('description: d\nauto: sometimes')[0]).toMatchObject({ line: 3, message: expect.stringContaining('auto is «sometimes»') });
  expect(at('description: d\nparams: a?, b', '{{a}} {{b}}')[0]).toMatchObject({ line: 3, message: expect.stringContaining('required parameter "b" follows an optional one') });
  expect(at('description: d\nparams: 1x', 'x')[0]).toMatchObject({ line: 3, message: expect.stringContaining('malformed parameter name «1x»') });
  expect(at('description: d\nparams: a, a', '{{a}}')[0]).toMatchObject({ line: 3, message: expect.stringContaining('declared twice') });
  expect(at('description: d\nnot a pair')[0]).toMatchObject({ line: 3, message: expect.stringContaining('expected "key: value"') });
});

test('a header that is missing or not closed is an error on line 1', () => {
  expect(errorsOf('description: d\n---\nbody')).toEqual([{ path: P, line: 1, message: expect.stringContaining('does not start with a header') }]);
  expect(errorsOf('---\ndescription: d\nbody')).toEqual([{ path: P, line: 1, message: expect.stringContaining('not closed') }]);
  expect(errorsOf('')[0]!.line).toBe(1);
});

test('a placeholder the header does not declare is an error on its own body line', () => {
  const e = errorsOf('---\ndescription: d\nparams: a\n---\nfirst {{a}}\n\nthen {{b}} here');
  expect(e).toEqual([{ path: P, line: 7, message: '{{b}} is not declared in params' }]);
});

test('a declared parameter the body never uses is an error on the params line', () => {
  expect(errorsOf('---\ndescription: d\nparams: a, b\n---\nonly {{a}}')).toEqual([{ path: P, line: 3, message: 'parameter "b" is never used in the body' }]);
});

test('single braces are left alone, and a malformed double-brace is an error', () => {
  const ok = parseAgentFile('/a/b.md', '---\ndescription: d\n---\n{ "a": {x} } and {y}');
  expect(ok.ok && ok.agent.body).toBe('{ "a": {x} } and {y}');
  expect(errorsOf('---\ndescription: d\n---\nuse {{ not a name }}')[0]).toMatchObject({ line: 4, message: expect.stringContaining('malformed placeholder') });
});

test('the name is the file name without .md and holds letters, digits and -', () => {
  const doc = '---\ndescription: d\n---\nb';
  expect(parseAgentFile('/a/Ticket-2.md', doc).ok).toBe(true);
  expect(errorsOf(doc, '/a/new_ticket.md')[0]).toMatchObject({ path: '/a/new_ticket.md', line: 1, message: expect.stringContaining('not an agent name') });
  expect(errorsOf(doc, '/a/ticket.txt')[0]!.message).toContain('not an agent name');
  expect(errorsOf(doc, '/a/new ticket.md')[0]!.message).toContain('not an agent name');
});

test('the hash is of the file bytes: stable for the same, different for one changed byte', () => {
  const hash = (text: string | Uint8Array) => {
    const r = parseAgentFile(P, text);
    if (!r.ok) throw new Error('bad');
    return r.agent.hash;
  };
  const doc = '---\ndescription: d\n---\nbody';
  expect(hash(doc)).toBe(hash(doc));
  expect(hash(doc)).toBe(hash(Buffer.from(doc)));
  expect(hash(doc)).toBe(agentHash(doc));
  expect(hash(doc)).not.toBe(hash(doc.replace('body', 'bodz')));
});

test('fillPrompt fills each placeholder; a missing optional is empty; a value is not read again', () => {
  const r = parseAgentFile(P, FULL);
  if (!r.ok) throw new Error('bad');
  expect(fillPrompt(r.agent, { ticket: 'PRICE-1', branch: 'fix' })).toContain('Open PRICE-1 and branch off fix.');
  expect(fillPrompt(r.agent, { ticket: 'PRICE-1' })).toContain('Open PRICE-1 and branch off .');
  expect(fillPrompt(r.agent, { ticket: '{{branch}}', branch: 'b' })).toContain('Open {{branch}} and branch off b.');
  expect(fillPrompt(r.agent, { ticket: 't' })).toContain('{"status": "ok"}');
});

test('the parameters read as the listing shows them', () => {
  expect(paramsText([{ name: 'ticket', optional: false }, { name: 'branch', optional: true }])).toBe('<ticket> [branch]');
});

test('a {{ … }} that spans lines is body text: the reader passes it and fillPrompt keeps it verbatim', () => {
  const body = 'Template:\n{{\n "a": 1\n}}\nend';
  const r = parseAgentFile(P, `---\ndescription: d\n---\n${body}`);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(fillPrompt(r.agent, {})).toBe(body);
});

test('a parameter named like an Object.prototype member is filled from its own value only', () => {
  const r = parseAgentFile(P, '---\ndescription: d\nparams: toString, other?\n---\nGo {{toString}}.{{other}}');
  if (!r.ok) throw new Error('bad');
  expect(fillPrompt(r.agent, { toString: 'now' })).toBe('Go now.');
  expect(fillPrompt(r.agent, {})).toBe('Go .');
});
