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

export function hasToolMarkup(text: string): boolean {
  return OPEN.test(text) || /<\/?｜[^<>\n]*>/.test(text);
}

export function stripToolMarkup(text: string): string {
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
export function markupToolNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/<(?:｜DSML｜)?invoke\b[^>]*\bname\s*=\s*"([^"]+)"/g)) names.add(m[1]!);
  for (const m of text.matchAll(/<tool_calls?>\s*\{[^]*?"name"\s*:\s*"([^"]+)"/g)) names.add(m[1]!);
  return [...names];
}
