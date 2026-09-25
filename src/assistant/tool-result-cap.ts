// Caps what ONE tool result may put into the model's history (src/assistant/agent.ts,
// the tool-run path). A tool can return arbitrarily much — a plugin's board listing
// once answered a "list" call with the whole board as raw JSON, 391,864 characters —
// and the result then rides on every LATER request too, since it stays in the
// conversation. This module decides how much of it the model actually gets; the
// rest is display only:
//   - the tool trail and a view (`ctx.liveView`/`reportView`) show what the person
//     asked to see, capped on their own terms (src/assistant/views.ts,
//     src/assistant/console-view.ts) — never by this;
//   - `ctx.reportChange`'s diff never reaches the model at all.
// Pure: no config or registry lookups here, so a caller resolves the numbers once
// and hands them in.

export const TOOL_RESULT_MAX_CHARS_DEFAULT = 40_000;
// A hard ceiling on a tool's own `maxResultChars` (the plugin tool type,
// src/loader/tools.ts): a plugin cannot flood the history just by declaring a
// bigger number.
export const TOOL_RESULT_MAX_CHARS_CEILING = 200_000;

// The head kept when a result is cut; the rest of the cap is a short tail — a result
// usually says what matters first, and the tail keeps whatever came last (a summary
// line, a total).
const HEAD_RATIO = 0.9;

const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

// `ai.toolResultMaxChars` (src/config/schema.ts), defaulted — what a caller resolves
// once from config and passes to `agentChat` as `toolResultMaxChars`.
export function toolResultCapFromConfig(ai: unknown): number {
  const v = (ai as { toolResultMaxChars?: unknown } | null | undefined)?.toolResultMaxChars;
  return isPositiveInt(v) ? v : TOOL_RESULT_MAX_CHARS_DEFAULT;
}

// The cap for ONE call: the tool's own `maxResultChars` when it declares a valid one,
// clamped to the hard ceiling — else the conversation's configured default.
export function resolveToolResultCap(configuredDefault: number, perTool: unknown): number {
  return isPositiveInt(perTool) ? Math.min(perTool, TOOL_RESULT_MAX_CHARS_CEILING) : configuredDefault;
}

// Cuts `text` to at most `max` characters, plus the note, when it is longer: the head
// (90% of `max`) and a short tail (the rest), with a note between them naming the
// total length so the model can ask the tool for less — filters, a limit, one item —
// rather than retrying blind. The note rides OUTSIDE `max`, so the caller gets at
// most `max` characters of the result plus the note itself.
export function capToolResult(text: string, max: number): string {
  if (!isPositiveInt(max) || text.length <= max) return text;
  const headLen = Math.max(0, Math.floor(max * HEAD_RATIO));
  const tailLen = Math.max(0, max - headLen);
  const head = text.slice(0, headLen);
  const tail = tailLen ? text.slice(text.length - tailLen) : '';
  const note = `\n… [cut: ${text.length} characters in all — ask the tool for less: filters, a limit, one item]\n`;
  return `${head}${note}${tail}`;
}

// Whether `text` carries the note `capToolResult` puts where it cut.
export const wasCut = (text: string): boolean => /\n… \[cut: \d+ characters in all — ask the tool for less: filters, a limit, one item\]\n/.test(text);
