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
// `patternProperties`). Nothing about a value is ever coerced: a number sent as the
// string `"3"` is a wrong type, not a value quietly accepted. `null` on a declared
// OPTIONAL key, at any level, is the one exception — read as the key left out (below),
// since that is how a tool already reads an absent one (`args.path ?? '.'`) and how an
// OpenAI-style client sends one it left blank.
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
    // The call's own unknown-key check (below) already covers the object's OWN top
    // level (`path: []`) — args says that better than zod's default message. A NESTED
    // one — inside a declared property's own object schema, `path` non-empty — is
    // never computed there, so it surfaces here instead: a plugin's own
    // `additionalProperties: false` on a nested shape (an MCP schema does this) is
    // enforced, not swallowed by the top-level check.
    if (issue.code === 'unrecognized_keys' && issue.path.length === 0) continue;
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

type ObjectSchema = { properties?: unknown; required?: unknown; patternProperties?: unknown; items?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// A `patternProperties` pattern that is not a valid regular expression matches no key:
// the schema reader tolerates one where it ignores the keyword, and a quirk there must
// not stop the tool.
function patternOf(source: string): RegExp | null {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

// A copy of `value` with every `null` on an OPTIONAL key dropped, at every level the
// schema walks an object's keys, so the schema validates it as omitted rather than as
// a value of the wrong type. A key is optional when the enclosing object schema
// declares it (`properties`, or a `patternProperties` pattern it matches) and does not
// list it in its own `required`. A REQUIRED key sent as `null` stays and fails like any
// other wrong type. An array item has no notion of optional, so a `null` item stays
// too; only the objects inside the items are walked. `value` itself is never mutated.
function withoutOptionalNulls(schema: unknown, value: unknown): unknown {
  if (!isRecord(schema)) return value;
  const s = schema as ObjectSchema;
  if (Array.isArray(value)) return isRecord(s.items) ? value.map((item) => withoutOptionalNulls(s.items, item)) : value;
  if (!isRecord(value)) return value;
  const properties = isRecord(s.properties) ? s.properties : {};
  const required = Array.isArray(s.required) ? s.required : [];
  const patterns = isRecord(s.patternProperties)
    ? Object.entries(s.patternProperties).flatMap(([p, sub]) => {
        const re = patternOf(p);
        return re ? [[re, sub] as const] : [];
      })
    : [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const sub = Object.prototype.hasOwnProperty.call(properties, k) ? properties[k] : patterns.find(([re]) => re.test(k))?.[1];
    const declared = sub !== undefined;
    if (v === null && declared && !required.includes(k)) continue;
    out[k] = declared ? withoutOptionalNulls(sub, v) : v;
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

  const patternProps = schema.patternProperties && typeof schema.patternProperties === 'object' ? schema.patternProperties : null;
  const patterns = patternProps ? Object.keys(patternProps).flatMap((p) => patternOf(p) ?? []) : [];
  // `additionalProperties: true`, or a schema of its own, always allows an extra key.
  // `patternProperties` alone (`additionalProperties` left unset) allows one that
  // matches no pattern too — JSON Schema's own default for that combination. An
  // EXPLICIT `false` means what it says regardless of `patternProperties`: only a
  // name in `properties` or matching a pattern is not unknown.
  const allowsExtra =
    schema.additionalProperties === true ||
    (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) ||
    (patterns.length > 0 && schema.additionalProperties !== false);
  const unknown = allowsExtra
    ? []
    : Object.keys(args).filter((k) => !Object.prototype.hasOwnProperty.call(properties, k) && !patterns.some((re) => re.test(k)));

  // The schema sees `args` with its optional `null`s dropped; `typeIssues` still reads
  // the original `args`, so a required key sent as `null` is reported as present. The
  // walk fails safe: should it throw on a schema shape it does not expect, the schema
  // sees `args` as sent.
  let forSchema: unknown;
  try {
    forSchema = withoutOptionalNulls(schema, args);
  } catch {
    forSchema = args;
  }
  const result = zSchema.safeParse(forSchema);
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
