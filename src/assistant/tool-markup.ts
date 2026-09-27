// Tool-call markup a model writes as TEXT when it means to call a tool and the call
// does not come out as one. One detector for every place it matters: a compaction's
// summary (./compaction.ts) and an answer that holds a call written as text
// (./agent.ts), which is asked for again as a real call.
//
// The shapes: DeepSeek's DSML (`<｜DSML｜function_calls>…`, the bar is U+FF5C), `<tool_call>`,
// `<function_calls>` and a bare `<invoke …>`. A block with no closing tag runs to the
// end of the text — a cut-off call is still a call.
const OPEN = /<(?:｜DSML｜)?(function_calls|tool_calls?|invoke)\b[^>]*>/;
// A stray DSML-family token: `<｜DSML｜…>`, `</｜DSML｜…>`, `<｜tool▁calls▁begin｜>`.
const STRAY = /<\/?｜[^<>\n]*>/g;

// Code is never markup: a fenced block or an inline span that shows the tags — an
// answer or a handoff about this very detector — is set aside before looking, and put
// back as it was. A placeholder is a run of private-use characters no model writes.
const CODE = /```[^]*?(?:```|$)|`[^`\n]+`/g;
function masked(text: string): { text: string; restore: (s: string) => string } {
  const kept: string[] = [];
  const out = text.replace(CODE, (m) => `\uE000${kept.push(m) - 1}\uE001`);
  return { text: out, restore: (s) => s.replace(/\uE000(\d+)\uE001/g, (_, i) => kept[Number(i)]!) };
}

export function hasToolMarkup(text: string): boolean {
  const t = masked(text).text;
  return OPEN.test(t) || /<\/?｜[^<>\n]*>/.test(t);
}

export function stripToolMarkup(text: string): string {
  const m0 = masked(text);
  return m0.restore(stripMasked(m0.text));
}

function stripMasked(text: string): string {
  let out = text;
  for (;;) {
    const m = OPEN.exec(out);
    if (!m) break;
    const close = new RegExp(`</(?:｜DSML｜)?${m[1]}>`);
    const rest = out.slice(m.index + m[0].length);
    const c = close.exec(rest);
    const end = c ? m.index + m[0].length + c.index + c[0].length : out.length;
    out = out.slice(0, m.index) + out.slice(end);
  }
  out = out.replace(STRAY, '');
  return out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

// The tool names the markup names: `<invoke name="x">` (either family) and the
// `"name": "x"` of a `<tool_call>` body.
export function markupToolNames(raw: string): string[] {
  const text = masked(raw).text;
  const names = new Set<string>();
  for (const m of text.matchAll(/<(?:｜DSML｜)?invoke\b[^>]*\bname\s*=\s*"([^"]+)"/g)) names.add(m[1]!);
  for (const m of text.matchAll(/<tool_calls?>\s*\{[^]*?"name"\s*:\s*"([^"]+)"/g)) names.add(m[1]!);
  return [...names];
}
