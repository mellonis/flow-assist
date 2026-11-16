// The parts of a model request a provider may refuse, and the bounded sequence that
// adjusts them. Both wires share it: the answer ceiling (`max_tokens`, which newer
// OpenAI models want as `max_completion_tokens`) and, on the OpenAI-compatible wire, the
// usage field (`stream_options`). A provider that knows neither still answers: one
// request, one retry per refusal, and no fourth.

import { CEILING_FALLBACK } from './llm-endpoint.js';

// What the request under way carries: the usage field, and the ceiling — the resolved
// value (`ask`), the smaller named fallback (`fallback`), or no ceiling at all (`none`) —
// under the name the provider takes it as (`ceilingField`: a host that named
// `max_completion_tokens` as its fix is asked under that name from then on).
export type WireFields = {
  usage: boolean;
  ceiling: 'ask' | 'fallback' | 'none';
  ceilingField?: 'max_tokens' | 'max_completion_tokens';
};

// The whole sequence: the first request and one retry per refusal.
const WIRE_REQUESTS_MAX = 3;

// A refusal names the field it will not take; a server that wants the newer name says
// so in the same sentence.
const namesCeilingField = (body: string): boolean => /max_tokens|max_completion_tokens/i.test(body);
const namesUsageField = (body: string): boolean => /stream_options|include_usage/i.test(body);

// Which ceiling refusal a 400 carries, each answered only by its own step:
// - `rename`: the body names `max_completion_tokens` as what to use instead ("Use
//   'max_completion_tokens' instead") — one retry under that name, the same ceiling;
// - `value`: the field is right but the number is not ("too large", "exceeds",
//   "supports at most N", "must be under", a number over its maximum) — one retry at
//   the smaller fallback;
// - `name`: a plain name or unknown-field refusal — the field is dropped.
export type CeilingSignal = 'rename' | 'value' | 'name';

const renamesCeilingField = (body: string): boolean =>
  /\buse\b[^.\n]{0,40}\bmax_completion_tokens\b[^.\n]{0,20}instead\b/i.test(body)
  || /\bmax_completion_tokens\b[^.\n]{0,40}\binstead\s+of\b/i.test(body);
const refusesCeilingValue = (body: string): boolean =>
  /too\s+(?:large|long|big|high)|exceeds?|supports?\s+at\s+most|must\s+be\s+(?:under|below|less)|may\s+not\s+exceed|cannot\s+be\s+(?:more|greater|higher)|\d[\d.,]*\s*>\s*\d[\d.,]*/i.test(body);

export function ceilingRefusal(body: string): CeilingSignal | null {
  if (!namesCeilingField(body)) return null;
  if (renamesCeilingField(body)) return 'rename';
  if (refusesCeilingValue(body)) return 'value';
  return 'name';
}

// The step each wire takes for each ceiling refusal shape: where the retry's ceiling
// stands, `rename` taking the field name the provider asked for (the same ceiling), and
// `null` meaning the wire has no step for that shape — the request fails on it.
export type CeilingSteps = {
  rename: 'rename' | 'fallback' | 'none' | null;
  value: 'fallback' | 'none' | null;
  name: 'none' | 'fallback' | null;
};

// The OpenAI-compatible wire may rename, lower and drop the field, in that order; the
// Anthropic wire must send `max_tokens` and cannot name it otherwise, so every ceiling
// refusal there takes the one recovery it has — the fallback, as it always did.
export const OPENAI_CEILING_STEPS: CeilingSteps = { rename: 'rename', value: 'fallback', name: 'none' };
export const ANTHROPIC_CEILING_STEPS: CeilingSteps = { rename: 'fallback', value: 'fallback', name: 'fallback' };

// `send` makes one request with the fields it is given. `next` reads a failed response
// and answers the fields its retry carries, or null when the failure is not one this
// sequence handles — or when nothing is left to drop.
export async function sendWithRefusals(
  start: WireFields,
  send: (fields: WireFields) => Promise<Response>,
  next: (fields: WireFields, res: Response, body: string) => WireFields | null,
): Promise<{ res: Response; body: string }> {
  let fields = start;
  for (let n = 1; ; n += 1) {
    const res = await send(fields);
    if (res.ok) return { res, body: '' };
    const body = await res.text().catch(() => '');
    const retry = n < WIRE_REQUESTS_MAX ? next(fields, res, body) : null;
    if (!retry) return { res, body };
    fields = retry;
  }
}

// The one verdict both wires read: a 400 that names the usage field drops it; a 400 that
// names the ceiling takes that ceiling's own step — `null` where there is no next state
// for the shape it carries (each step only on its own signal, and a second refusal of a
// step fails the request). Each refusal is reported through `remember` with what it is
// remembered as, so the next request of this process starts with the fix already.
export function retryFields(
  fields: WireFields,
  res: Response,
  body: string,
  o: {
    ceiling: CeilingSteps;
    remember: (refused: 'usage' | 'ceiling', add: CeilingMemory) => void;
  },
): WireFields | null {
  if (res.status !== 400) return null;
  if (fields.usage && namesUsageField(body)) {
    o.remember('usage', {});
    return { ...fields, usage: false };
  }
  if (fields.ceiling === 'none') return null;
  const signal = ceilingRefusal(body);
  if (!signal) return null;
  const next = ceilingStep(fields, signal, o.ceiling);
  if (!next) return null;
  o.remember('ceiling', {
    ...(fields.ceilingField !== 'max_completion_tokens' && next.ceilingField === 'max_completion_tokens' ? { field: 'max_completion_tokens' as const } : {}),
    ...(next.ceiling !== fields.ceiling && next.ceiling !== 'ask' ? { value: next.ceiling as 'fallback' | 'none' } : {}),
  });
  return next;
}

// One ceiling step — never back to a state the sequence has already left, so the bound
// (`WIRE_REQUESTS_MAX`) is never all that stops a run of refusals.
function ceilingStep(fields: WireFields, signal: CeilingSignal, steps: CeilingSteps): WireFields | null {
  if (signal === 'rename') {
    // One rename, carrying the same ceiling: a second refusal of the renamed field has
    // no step and fails the request.
    if (fields.ceilingField === 'max_completion_tokens') return null;
    const to = steps.rename;
    if (!to) return null;
    return to === 'rename' ? { ...fields, ceilingField: 'max_completion_tokens' } : { ...fields, ceiling: to };
  }
  const to = signal === 'value' ? steps.value : steps.name;
  // A second refusal of a step — the value refused again at the fallback, the name
  // again where there is nothing left to drop — fails the request.
  if (!to || to === fields.ceiling) return null;
  return { ...fields, ceiling: to };
}

// What one refusal is remembered as: the field name the ceiling goes as now (`field`),
// and the ceiling the next request starts at (`value`, absent — the resolved ceiling as
// ever). Each piece is remembered alone — a rename and a lowered value can both land on
// one key.
export type CeilingMemory = { field?: 'max_completion_tokens'; value?: 'fallback' | 'none' };

// The ceilings a provider refused, by wire, base URL and model: the value refused is the
// model's own output cap, so another model on the same host is asked as it was.
const ceilingMemories = new Map<string, CeilingMemory>();
const ceilingKey = (wire: 'openai' | 'anthropic', baseUrl: string | undefined, model: string | undefined): string => `${wire}\n${baseUrl ?? ''}\n${model ?? ''}`;

export const ceilingMemory = (wire: 'openai' | 'anthropic', baseUrl: string | undefined, model: string | undefined): CeilingMemory =>
  ceilingMemories.get(ceilingKey(wire, baseUrl, model)) ?? {};

// Remember a ceiling refusal and say it once — a degradation nobody is told of is a
// silent one. `note` is the caller's line for the person (the request path's
// `AgentOpts.onNote`); without one the memory still lands, quietly.
export const rememberCeilingRefusal = (
  wire: 'openai' | 'anthropic',
  baseUrl: string | undefined,
  model: string | undefined,
  add: CeilingMemory,
  note?: (line: string) => void,
): void => {
  const key = ceilingKey(wire, baseUrl, model);
  ceilingMemories.set(key, { ...ceilingMemories.get(key), ...add });
  note?.(ceilingRefusalLine(model, baseUrl, add));
};

// The one line a remembered refusal says, on the note channel the caller passes.
export function ceilingRefusalLine(model: string | undefined, baseUrl: string | undefined, add: CeilingMemory): string {
  const who = model ?? baseUrl ?? 'the provider';
  return `[llm] ${who} refused max_tokens — ${
    add.value === 'none' ? 'no answer ceiling is sent from now on'
      : add.value === 'fallback' ? `the answer ceiling goes at ${CEILING_FALLBACK} or lower from now on`
        : 'the answer ceiling goes as max_completion_tokens from now on'
  }`;
}
