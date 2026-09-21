import { expect, test } from 'bun:test';
import { copyTarget, copyToClipboard } from '../copy.ts';

const chat = (answer: string) => [
  { role: 'user', content: 'как проверить локально?' },
  { role: 'assistant', content: 'старый ответ' },
  { role: 'user', content: 'ещё' },
  { role: 'assistant', content: answer },
  { role: 'bg', content: 'фоновый результат' },
];

test('bare /copy takes the last code block of the last answer, as written', () => {
  const answer = 'Сначала поставь зависимости:\n\n```sh\nbun install\n```\n\nПотом прогон:\n\n```sh title="run"\nbun test src/features/routes\n```\n';
  expect(copyTarget(chat(answer), '')).toEqual({ text: 'bun test src/features/routes', what: 'the sh code block' });
});

test('an answer without code is copied whole; "answer" always copies it whole', () => {
  expect(copyTarget(chat('Всё зелёное.'), '')).toEqual({ text: 'Всё зелёное.', what: 'the answer' });
  const withCode = 'Вот:\n\n```ts\nconst a = 1;\n```';
  expect(copyTarget(chat(withCode), 'answer')).toEqual({ text: withCode, what: 'the answer' });
});

test('/copy code without a block, an unknown word, or no answer yet say why', () => {
  expect(copyTarget(chat('Без кода.'), 'code')).toEqual({ error: expect.stringMatching(/no code block/) });
  expect(copyTarget(chat('x'), 'all')).toEqual({ error: expect.stringMatching(/"code" or "answer"/) });
  expect(copyTarget([{ role: 'user', content: 'привет' }], '')).toEqual({ error: expect.stringMatching(/nothing to copy/) });
});

test('the clipboard is written by the platform tool, with the text on its stdin', () => {
  const calls: [string, string[], string][] = [];
  const exec = (cmd: string, args: string[], input: string) => { calls.push([cmd, args, input]); return { ok: true }; };
  expect(copyToClipboard('текст', 'darwin', exec)).toEqual({ ok: true });
  expect(calls).toEqual([['pbcopy', [], 'текст']]);

  // Linux: the first tool that works; none — an error naming them all.
  calls.length = 0;
  const onlyXclip = (cmd: string, args: string[], input: string) => { calls.push([cmd, args, input]); return { ok: cmd === 'xclip' }; };
  expect(copyToClipboard('x', 'linux', onlyXclip)).toEqual({ ok: true });
  expect(calls.map(([c]) => c)).toEqual(['wl-copy', 'xclip']);
  expect(copyToClipboard('x', 'linux', () => ({ ok: false }))).toEqual({ ok: false, error: expect.stringMatching(/wl-copy, xclip, xsel/) });
});
