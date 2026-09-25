// Checks a tool call's arguments against the tool's own declared JSON Schema
// (`ToolDef.function.parameters`) before the call runs. A model that names a wrong
// key — `{ code: 'ABC-1' }` for a tool whose schema requires `issueCode` — otherwise
// reaches the tool with the right field missing; the tool builds a request from
// `undefined` and fails on the wire, and the model has to guess why. Checking here
// answers it directly: which parameter is missing, which key it does not recognize,
// which value is the wrong type.
//
// `additionalProperties` absent from a schema is JSON Schema's own default for "allow
// anything not listed" — but an extra key is, in practice, almost always a typo of a
// required one, so this host treats "absent" as "report it" and requires a schema to
// opt IN to extra keys with `additionalProperties: true` (or a schema of its own, or
// `patternProperties`). Nothing about `args` is ever coerced or stripped: a schema
// that would accept the call sees it unchanged.
import { z } from 'zod';
import type { ToolParameters } from '../loader/tools.js';

// A schema with no declared properties says nothing a call could get wrong — the tool
// takes anything, including no arguments at all.
function isEmptySchema(schema: ToolParameters | null | undefined): boolean {
  if (!schema || typeof schema !== 'object') return true;
  const props = (schema as { properties?: unknown }).properties;
  return !props || typeof props !== 'object' || Object.keys(props).length === 0;
}

// Compiled once per schema object (a tool's `parameters` is built once, at load, and
// reused for every call). A schema zod's JSON Schema reader cannot compile — an
// exotic keyword (`if`/`then`, `unevaluatedProperties`, a draft-07 `$ref`) — is logged
// once, right here, the first time it is met, and treated from then on as "nothing to
// check": a plugin author's schema quirk must not stop their tool from running.
const compiled = new WeakMap<object, z.ZodType | null>();

function compile(toolName: string, schema: ToolParameters): z.ZodType | null {
  const cached = compiled.get(schema);
  if (cached !== undefined) return cached;
  let zSchema: z.ZodType | null;
  try {
    zSchema = z.fromJSONSchema(schema as never);
  } catch (e) {
    console.warn(`[tools] ${toolName}: parameters is not a JSON Schema zod reads (${e instanceof Error ? e.message : String(e)}) — running unchecked.`);
    zSchema = null;
  }
  compiled.set(schema, zSchema);
  return zSchema;
}

// `[a][0].b` — a nested path the way the model reads a JSON pointer at a glance.
function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, seg, i) => (typeof seg === 'number' ? `${acc}[${seg}]` : i === 0 ? String(seg) : `${acc}.${String(seg)}`), '');
}

// zod reports a missing required key as `invalid_type … received undefined` at a
// one-deep path — indistinguishable, by code alone, from a key that is PRESENT with
// the wrong type. `args` (never zod's parsed output, which fills in a property
// `default`) is what says which one it is.
function typeIssues(issues: readonly z.core.$ZodIssue[], args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') continue; // ours, below — args says this better than zod's own message
    if (issue.code === 'invalid_type' && issue.path.length === 1) {
      const key = String(issue.path[0]);
      if (!Object.prototype.hasOwnProperty.call(args, key)) continue; // missing — counted from `required` below
      out.push(`\`${key}\` must be ${issue.expected}`);
      continue;
    }
    const path = formatPath(issue.path);
    out.push(path ? `\`${path}\`: ${issue.message}` : issue.message);
  }
  return out;
}

const MAX_LISTED = 3;

// Up to the first three names, `` `a`, `b`, `c` ``, with the rest counted rather than
// spelled out — the line stays one line whatever the schema declares.
function listCap(keys: readonly string[]): string {
  const shown = keys.slice(0, MAX_LISTED);
  const rest = keys.length - shown.length;
  return `${shown.map((k) => `\`${k}\``).join(', ')}${rest > 0 ? ` … ${rest} more` : ''}`;
}

// One line naming what is wrong with `args` for this tool's `parameters`, or `null`
// when they satisfy it (or there is nothing to check). Never mutates `args`.
export function toolArgsError(toolName: string, parameters: ToolParameters | null | undefined, args: Record<string, unknown>): string | null {
  if (isEmptySchema(parameters)) return null;
  const schema = parameters as ToolParameters & { properties?: Record<string, unknown>; required?: unknown; additionalProperties?: unknown; patternProperties?: unknown };
  // A schema zod cannot read is not a schema this function can hold anyone to: run the
  // call as if there were none.
  const zSchema = compile(toolName, schema);
  if (!zSchema) return null;

  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [];
  const missing = required.filter((k) => !Object.prototype.hasOwnProperty.call(args, k));
  const allowsExtra =
    schema.additionalProperties === true ||
    (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) ||
    schema.patternProperties !== undefined;
  const unknown = allowsExtra ? [] : Object.keys(args).filter((k) => !Object.prototype.hasOwnProperty.call(properties, k));

  const result = zSchema.safeParse(args);
  const wrongType = result.success ? [] : typeIssues(result.error.issues, args);

  if (!missing.length && !unknown.length && !wrongType.length) return null;

  const problems: string[] = [];
  // One missing key beside one unrecognized one reads, almost always, as the same
  // mistake — the model spelled the required parameter differently — so it gets one
  // line naming both instead of two that talk past each other.
  if (missing.length === 1 && unknown.length === 1) {
    problems.push(`unknown \`${unknown[0]}\` — did you mean \`${missing[0]}\`?`);
  } else {
    if (missing.length) problems.push(`missing required parameter${missing.length > 1 ? 's' : ''} ${listCap(missing)}`);
    if (unknown.length) problems.push(`unknown parameter${unknown.length > 1 ? 's' : ''} ${listCap(unknown)}`);
  }
  problems.push(...wrongType.slice(0, MAX_LISTED));

  const body = problems.join('; ');
  // The "did you mean" clause already ends in `?`; a period right after it would read
  // as two closing marks in a row.
  const sep = /[?!.]$/.test(body) ? ' ' : '. ';
  return `wrong arguments for ${toolName} — ${body}${sep}Nothing was run.`;
}
