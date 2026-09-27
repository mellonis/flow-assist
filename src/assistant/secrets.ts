// The secrets the host knows, and the one function that takes them out of text.
//
// The host knows secret VALUES: the environment variables its config names (`${VAR}`
// in any string value, `ai.tokenEnv` or its default), every variable whose NAME says
// it is a secret (`SECRET_NAME_RE` — a plugin's `requiredSettings` token among them;
// the plugin API has no other way to call a setting secret), and a literal credential written at a secret-looking key of the
// config itself (an MCP server's `headers.Authorization`). A system variable
// (`PATH`, `HOME`, …) is never one, whatever names it: a stdio server's `env` commonly
// passes `${PATH}` through, and redacting every path would ruin every output.
//
// `redactSecrets` replaces each occurrence of a value — and of its base64, base64url
// and URL-encoded forms — with `‹secret NAME›`. A value shorter than
// `SECRET_MIN_LENGTH` is never redacted (it would match ordinary words), though the
// variable is still withheld from the model's commands (`withheldEnv`).
//
// The set is the process's: built at start (`refreshSecrets`) and again whenever the
// config changes, read through `activeSecrets()` by every choke point — a tool's result,
// command output, a view's text, the model's answer, the log. Nothing here logs or
// returns a value outside the set itself.
import { llmOpts } from './llm-endpoint.js';

export const SECRET_NAME_RE = /TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|API_?KEY|_KEY$/i;
// A key of the config whose literal string value is a credential.
const SECRET_KEY_RE = /TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|API_?KEY|_KEY$|^authorization$/i;
export const SECRET_MIN_LENGTH = 8;

const SYSTEM_NAMES = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'TMPDIR', 'TEMP', 'TMP', 'TERM', 'LANG', 'LANGUAGE', 'EDITOR', 'VISUAL', 'PAGER', 'HOSTNAME', 'NODE_ENV', 'COLORTERM', 'TERM_PROGRAM', 'SHLVL']);
export const isSystemVariable = (name: string): boolean => SYSTEM_NAMES.has(name) || /^(LC_|XDG_)/.test(name);

export interface SecretSet {
  // Every secret variable set (non-empty) in the environment the set was built from,
  // sorted — what the model's commands are started without.
  names: string[];
  // Each redactable text and the name it is shown as; longest first.
  forms: { text: string; name: string }[];
  maxLength: number;
}

// Every `${VAR}` named in a string of the config, and every literal at a secret key.
function walkConfig(value: unknown, path: string[], refs: Set<string>, literals: { path: string; value: string }[]): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) refs.add(m[1]!);
    const key = path.at(-1) ?? '';
    if (SECRET_KEY_RE.test(key) && !value.includes('${')) literals.push({ path: path.join('.'), value });
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => walkConfig(v, [...path, String(i)], refs, literals)); return; }
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkConfig(v, [...path, k], refs, literals);
}

// The forms a value is redacted in: itself, base64 and base64url without padding (so a
// form embedded before its `=` still matches), URL-encoded.
function formsOf(value: string): string[] {
  const b = Buffer.from(value, 'utf8');
  return [...new Set([value, b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), encodeURIComponent(value)])];
}

export function buildSecretSet(config: Record<string, unknown> | undefined, env: Record<string, string | undefined> = process.env): SecretSet {
  const refs = new Set<string>();
  const literals: { path: string; value: string }[] = [];
  walkConfig(config ?? {}, [], refs, literals);
  const named = new Set<string>([...refs, llmOpts(config?.ai, env).tokenEnv]);
  for (const k of Object.keys(env)) if (SECRET_NAME_RE.test(k)) named.add(k);
  const names = [...named].filter((n) => n && !isSystemVariable(n) && typeof env[n] === 'string' && env[n] !== '').sort();
  const byText = new Map<string, string>();
  const add = (value: string, name: string) => {
    if (value.length < SECRET_MIN_LENGTH) return;
    for (const f of formsOf(value)) if (f.length >= SECRET_MIN_LENGTH && !byText.has(f)) byText.set(f, name);
  };
  for (const n of names) add(env[n]!, n);
  for (const l of literals) {
    add(l.value, l.path);
    // `Bearer xyz` — the credential after the scheme is sent on its own as often.
    const cred = /^(?:Bearer|Basic|Token)\s+(\S+)$/i.exec(l.value.trim())?.[1];
    if (cred) add(cred, l.path);
  }
  const forms = [...byText].map(([text, name]) => ({ text, name })).sort((a, b) => b.text.length - a.text.length);
  return { names, forms, maxLength: forms.reduce((m, f) => Math.max(m, f.text.length), 0) };
}

let ACTIVE: SecretSet | null = null;
export function setActiveSecrets(set: SecretSet | null): void {
  ACTIVE = set;
}
export function activeSecrets(): SecretSet | null {
  return ACTIVE;
}
// Where the environment is read from: the process's. The test rig points it at the
// variables a test set itself, so the machine's own tokens never shape a test.
let ENV_SOURCE: () => Record<string, string | undefined> = () => process.env;
export function setSecretsEnv(source: (() => Record<string, string | undefined>) | null): void {
  ENV_SOURCE = source ?? (() => process.env);
}
// Builds the set from the config and the environment and makes it the active one — at
// start, and whenever the config changes.
export function refreshSecrets(config: Record<string, unknown> | undefined): SecretSet {
  const set = buildSecretSet(config, ENV_SOURCE());
  setActiveSecrets(set);
  return set;
}

// The environment a command the MODEL runs is started with: `env` without every
// variable of the set (`set.names`), except those the person lets through
// (`shell.passEnv`). `withheld` names what was taken out and was there to take, sorted
// — what the model is told, by name only.
export function withheldEnv(env: Record<string, string | undefined>, set: SecretSet | null, pass: readonly string[] = []): { env: Record<string, string | undefined>; withheld: string[] } {
  const out = { ...env };
  const withheld: string[] = [];
  for (const name of set?.names ?? []) {
    if (pass.includes(name) || out[name] === undefined) continue;
    delete out[name];
    withheld.push(name);
  }
  return { env: out, withheld: withheld.sort() };
}

// One alternation, longest form first: at any position the longest secret matches.
const PATTERNS = new WeakMap<SecretSet, { re: RegExp; nameOf: Map<string, string> }>();
function patternOf(set: SecretSet): { re: RegExp; nameOf: Map<string, string> } | null {
  if (!set.forms.length) return null;
  let p = PATTERNS.get(set);
  if (!p) {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    p = { re: new RegExp(set.forms.map((f) => esc(f.text)).join('|'), 'g'), nameOf: new Map(set.forms.map((f) => [f.text, f.name])) };
    PATTERNS.set(set, p);
  }
  return p;
}

export const secretMark = (name: string): string => `‹secret ${name}›`;

// The escape sequences a terminal consumes — CSI, OSC (to BEL or ST), the two-character
// ones — and one cut off at the end of a chunk. A match is looked for in the text with
// them taken out, so `grep --color` painting part of a token does not hide it; the
// sequences inside a match go with it.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const ANSI_CUT = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)?$/;
// The text without escape sequences, and where each of its characters stood (`at`,
// one entry more: the original's length).
function visible(text: string): { text: string; at: number[] } {
  if (!text.includes('\x1b')) return { text, at: [] };
  let out = '';
  const at: number[] = [];
  let last = 0;
  ANSI.lastIndex = 0;
  for (const m of text.matchAll(ANSI)) {
    for (let i = last; i < m.index!; i++) { out += text[i]; at.push(i); }
    last = m.index! + m[0].length;
  }
  for (let i = last; i < text.length; i++) { out += text[i]; at.push(i); }
  at.push(text.length);
  return { text: out, at };
}
const origin = (v: { at: number[] }, i: number): number => (v.at.length ? v.at[i]! : i);

// Every match in `text`, as spans of the text as it is.
function matchSpans(text: string, p: { re: RegExp; nameOf: Map<string, string> }): { start: number; end: number; name: string }[] {
  const v = visible(text);
  const out: { start: number; end: number; name: string }[] = [];
  p.re.lastIndex = 0;
  for (const m of v.text.matchAll(p.re)) {
    out.push({ start: origin(v, m.index!), end: origin(v, m.index! + m[0].length - 1) + 1, name: p.nameOf.get(m[0]) ?? 'value' });
  }
  return out;
}

export function redactSecrets(text: string, set: SecretSet | null = ACTIVE): string {
  if (!set || typeof text !== 'string' || !text) return text;
  const p = patternOf(set);
  if (!p) return text;
  if (!text.includes('\x1b')) return text.replace(p.re, (m) => secretMark(p.nameOf.get(m) ?? 'value'));
  let out = '';
  let last = 0;
  for (const m of matchSpans(text, p)) { out += text.slice(last, m.start) + secretMark(m.name); last = m.end; }
  return out + text.slice(last);
}

// Every string of a JSON-like value redacted; everything else as it is.
export function redactDeep<T>(value: T, set: SecretSet | null = ACTIVE): T {
  if (!set || !set.forms.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactSecrets(v, set);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

// Redaction over a stream of chunks: `push` returns what may go out now, redacted, and
// holds back the shortest tail that could still grow into a secret (a chunk boundary
// may split one, or an escape sequence be cut off); `flush` gives the rest. Nothing
// emitted ever holds a piece of a secret that the next chunk completes, and a held tail
// is never emitted in clear: at `flush` a tail of `SECRET_MIN_LENGTH` or more that
// begins a secret — output cut off inside a token, a token less its last character —
// goes out as that secret's mark. One stream per source: two sources interleaved
// (stdout and stderr) would split each other's tokens.
export interface SecretStream {
  push(chunk: string): string;
  flush(): string;
}
export function secretStream(set: SecretSet | null = ACTIVE): SecretStream {
  let buf = '';
  const p = set ? patternOf(set) : null;
  if (!set || !p) return { push: (c) => c, flush: () => '' };
  // Where the held tail starts, in the text as it is: an escape sequence cut off at the
  // end, else the first visible position whose tail is a proper prefix of some form.
  const holdFrom = (s: string): number => {
    const cut = ANSI_CUT.exec(s);
    const limit = cut ? cut.index : s.length;
    const v = visible(s.slice(0, limit));
    for (let i = Math.max(0, v.text.length - set.maxLength + 1); i < v.text.length; i++) {
      const tail = v.text.slice(i);
      if (set.forms.some((f) => f.text.length > tail.length && f.text.startsWith(tail))) return origin(v, i);
    }
    return limit;
  };
  return {
    push(chunk: string): string {
      if (!chunk) return '';
      buf += chunk;
      let h = holdFrom(buf);
      // A whole match that the hold would cut is held with it.
      for (const m of matchSpans(buf, p)) {
        if (m.start < h && m.end > h) { h = m.start; break; }
      }
      const out = buf.slice(0, h);
      buf = buf.slice(h);
      return redactSecrets(out, set);
    },
    flush(): string {
      const h = holdFrom(buf);
      const tail = visible(buf.slice(h)).text;
      const begun = h < buf.length && tail.length >= SECRET_MIN_LENGTH
        ? set.forms.find((f) => f.text.length > tail.length && f.text.startsWith(tail))
        : undefined;
      const out = begun ? redactSecrets(buf.slice(0, h), set) + secretMark(begun.name) : redactSecrets(buf, set);
      buf = '';
      return out;
    },
  };
}
