// `/copy` in the chat: the last answer, or a code block of it, onto the system
// clipboard — without the mouse. And the platform's own clipboard tool (pbcopy on
// macOS, wl-copy, xclip or xsel on Linux), for every copy the terminal cannot take:
// the host tries the terminal's clipboard sequence (OSC 52, through flowtty) first,
// and Apple Terminal has none (`services.copy`, `onCopySelection` in runtime/app.tsx).
import { spawnSync } from 'node:child_process';
import { layoutMarkdownDetailed } from '@flowtty/react';

type Message = { role?: string; content?: unknown };

// What `/copy [code|answer]` takes from the conversation. Bare: the last code block of
// the last answer, or the whole answer when it has none.
export function copyTarget(messages: Message[], arg: string): { text: string; what: string } | { error: string } {
  const answer = [...messages].reverse().find((m) => m.role === 'assistant' && String(m.content ?? '').trim());
  if (!answer) return { error: 'nothing to copy yet — no answer in this chat' };
  const text = String(answer.content);
  const mode = arg.trim().toLowerCase();
  if (mode && mode !== 'code' && mode !== 'answer') return { error: `/copy takes "code" or "answer", not "${arg.trim()}"` };
  if (mode === 'answer') return { text, what: 'the answer' };
  const blocks = layoutMarkdownDetailed(text, 200).codeBlocks.filter((b) => b.source.trim());
  const last = blocks.at(-1);
  if (last) return { text: last.source.replace(/\n$/, ''), what: `the ${last.lang ? `${last.lang} ` : ''}code block` };
  if (mode === 'code') return { error: 'the last answer has no code block — /copy answer takes all of it' };
  return { text, what: 'the answer' };
}

type Run = (cmd: string, args: string[], input: string) => { ok: boolean };
const run: Run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
  return { ok: !r.error && r.status === 0 };
};

// Puts `text` on the clipboard, or says that no tool could.
export function copyToClipboard(text: string, platform: string = process.platform, exec: Run = run): { ok: true } | { ok: false; error: string } {
  const tools: [string, string[]][] = platform === 'darwin'
    ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of tools) if (exec(cmd, args, text).ok) return { ok: true };
  return { ok: false, error: `no clipboard tool worked (tried ${tools.map(([c]) => c).join(', ')})` };
}
