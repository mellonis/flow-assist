// The parts of a model request a provider may refuse BY NAME, and the bounded sequence
// that drops them. Both wires share it: the answer ceiling (`max_tokens`, which newer
// OpenAI models want as `max_completion_tokens`) and, on the OpenAI-compatible wire, the
// usage field (`stream_options`). A provider that knows neither still answers: one
// request, one retry per refusal, and no fourth.

// What the request under way carries: the usage field, and the ceiling — the resolved
// value (`ask`), the named smaller fallback (`fallback`), or no ceiling at all (`none`).
export type WireFields = { usage: boolean; ceiling: 'ask' | 'fallback' | 'none' };

// The whole sequence: the first request and one retry per refusal.
const WIRE_REQUESTS_MAX = 3;

// A refusal names the field it will not take; a server that wants the newer name says
// so in the same sentence.
const namesCeilingField = (body: string): boolean => /max_tokens|max_completion_tokens/i.test(body);
const namesUsageField = (body: string): boolean => /stream_options|include_usage/i.test(body);

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
// names the ceiling drops it (`none`) or lowers it to the fallback (`fallback`) — `null`
// where there is nothing lower to ask. Each refusal is reported through `remember`, so
// the next request of this process starts without it.
export function retryFields(
  fields: WireFields,
  res: Response,
  body: string,
  o: { ceiling: 'none' | 'fallback' | null; remember: (refused: 'usage' | 'ceiling') => void },
): WireFields | null {
  if (res.status !== 400) return null;
  if (fields.usage && namesUsageField(body)) {
    o.remember('usage');
    return { ...fields, usage: false };
  }
  if (fields.ceiling === 'ask' && o.ceiling && namesCeilingField(body)) {
    o.remember('ceiling');
    return { ...fields, ceiling: o.ceiling };
  }
  return null;
}

// The ceilings a provider refused, by wire, base URL and model: the value refused is the
// model's own output cap, so another model on the same host is asked as it was.
const refusedCeilings = new Set<string>();
const ceilingKey = (wire: 'openai' | 'anthropic', baseUrl: string | undefined, model: string | undefined): string => `${wire}\n${baseUrl ?? ''}\n${model ?? ''}`;

export const ceilingRefused = (wire: 'openai' | 'anthropic', baseUrl: string | undefined, model: string | undefined): boolean =>
  refusedCeilings.has(ceilingKey(wire, baseUrl, model));

export const rememberCeilingRefusal = (wire: 'openai' | 'anthropic', baseUrl: string | undefined, model: string | undefined): void => {
  refusedCeilings.add(ceilingKey(wire, baseUrl, model));
};
