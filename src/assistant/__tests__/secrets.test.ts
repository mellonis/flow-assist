// The secret set and its redaction: which variables count, their encoded forms, and a
// stream that never lets a secret through when a chunk boundary splits it.
import { afterEach, expect, test } from 'bun:test';
import { activeSecrets, buildSecretSet, redactDeep, redactSecrets, secretStream, setActiveSecrets } from '../secrets.ts';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.payload-of-the-token.signature';
const env = { WB_WIKI_TOKEN: TOKEN, PATH: '/usr/bin:/bin', HOME: '/Users/me', SHORT_TOKEN: 'abc', MY_CONFIG_VALUE: 'nothing-secret-here', TRACKER_URL: 'https://tracker.example.com' };

afterEach(() => { setActiveSecrets(null); });

test('a variable whose name says it is a secret is one, by its value', () => {
  const set = buildSecretSet({}, env);
  expect(redactSecrets(`token=${TOKEN}.`, set)).toBe('token=‹secret WB_WIKI_TOKEN›.');
  expect(set.names).toContain('WB_WIKI_TOKEN');
  expect(set.names).not.toContain('MY_CONFIG_VALUE');
});

test('a value under 8 characters is withheld but never redacted', () => {
  const set = buildSecretSet({}, env);
  expect(set.names).toContain('SHORT_TOKEN');
  expect(redactSecrets('abc abc', set)).toBe('abc abc');
});

test('a variable config names is one — ${VAR} anywhere, ai.tokenEnv — but never a system variable', () => {
  const config = { ai: { tokenEnv: 'MY_LLM' }, plugins: { mcp: { servers: { wiki: { url: '${TRACKER_URL}/mcp', env: { PATH: '${PATH}', HOME: '${HOME}' } } } } } };
  const set = buildSecretSet(config, { ...env, MY_LLM: 'llm-credential-1234' });
  expect(set.names).toEqual(expect.arrayContaining(['MY_LLM', 'TRACKER_URL', 'WB_WIKI_TOKEN']));
  expect(set.names).not.toContain('PATH');
  expect(set.names).not.toContain('HOME');
  expect(redactSecrets('llm-credential-1234', set)).toBe('‹secret MY_LLM›');
  expect(redactSecrets('/usr/bin:/bin /Users/me', set)).toBe('/usr/bin:/bin /Users/me');
});

test('a literal credential at a secret-looking key of the config is one, named by its path', () => {
  const config = { plugins: { mcp: { servers: { wiki: { headers: { Authorization: 'Bearer literal-credential-99' }, apiKey: 'plain-api-key-0001' } } } } };
  const set = buildSecretSet(config, {});
  expect(redactSecrets('sent Bearer literal-credential-99', set)).toBe('sent ‹secret plugins.mcp.servers.wiki.headers.Authorization›');
  expect(redactSecrets('only literal-credential-99', set)).toBe('only ‹secret plugins.mcp.servers.wiki.headers.Authorization›');
  expect(redactSecrets('plain-api-key-0001', set)).toBe('‹secret plugins.mcp.servers.wiki.apiKey›');
});

test('the base64 and URL-encoded forms are redacted too', () => {
  const value = 'p@ss word/with+symbols';
  const set = buildSecretSet({}, { DB_PASSWORD: value });
  const b64 = Buffer.from(value).toString('base64').replace(/=+$/, '');
  const b64url = Buffer.from(value).toString('base64url');
  expect(redactSecrets(`Basic ${b64}==`, set)).toBe('Basic ‹secret DB_PASSWORD›==');
  expect(redactSecrets(b64url, set)).toBe('‹secret DB_PASSWORD›');
  expect(redactSecrets(`?p=${encodeURIComponent(value)}&x`, set)).toBe('?p=‹secret DB_PASSWORD›&x');
});

test('the longest form wins where one is a prefix of another', () => {
  const set = buildSecretSet({}, { A_TOKEN: 'abcdefgh', B_TOKEN: 'abcdefgh-longer' });
  expect(redactSecrets('abcdefgh-longer abcdefgh', set)).toBe('‹secret B_TOKEN› ‹secret A_TOKEN›');
});

test('with no set, or an empty one, text is untouched', () => {
  expect(redactSecrets(TOKEN)).toBe(TOKEN);
  expect(redactSecrets(TOKEN, buildSecretSet({}, {}))).toBe(TOKEN);
});

test('the active set is what redactSecrets reads by default', () => {
  setActiveSecrets(buildSecretSet({}, env));
  expect(activeSecrets()?.names).toContain('WB_WIKI_TOKEN');
  expect(redactSecrets(TOKEN)).toBe('‹secret WB_WIKI_TOKEN›');
});

test('redactDeep reaches every string of a JSON value', () => {
  const set = buildSecretSet({}, env);
  expect(redactDeep({ a: [TOKEN, 1, null], b: { c: `x${TOKEN}` }, d: true }, set)).toEqual({ a: ['‹secret WB_WIKI_TOKEN›', 1, null], b: { c: 'x‹secret WB_WIKI_TOKEN›' }, d: true });
});

test('a stream redacts a secret split across chunks, at every split point', () => {
  const set = buildSecretSet({}, env);
  const text = `before ${TOKEN} after\n`;
  for (let at = 1; at < text.length; at++) {
    const s = secretStream(set);
    const out = s.push(text.slice(0, at)) + s.push(text.slice(at)) + s.flush();
    expect(out).toBe('before ‹secret WB_WIKI_TOKEN› after\n');
  }
});

test('a stream split into single characters still redacts, and an encoded form too', () => {
  const set = buildSecretSet({}, env);
  const b64 = Buffer.from(TOKEN).toString('base64').replace(/=+$/, '');
  const text = `a ${TOKEN} b ${b64} c`;
  const s = secretStream(set);
  let out = '';
  for (const ch of text) {
    const got = s.push(ch);
    // Nothing emitted so far ever holds a piece of the secret.
    expect(got.includes(TOKEN.slice(0, 12)) || got.includes(b64.slice(0, 12))).toBe(false);
    out += got;
  }
  out += s.flush();
  expect(out).toBe('a ‹secret WB_WIKI_TOKEN› b ‹secret WB_WIKI_TOKEN› c');
});

test('a stream holds back only what could still become a secret', () => {
  const set = buildSecretSet({}, env);
  const s = secretStream(set);
  expect(s.push('hello\n')).toBe('hello\n');
  expect(s.push('x eyJhb')).toBe('x ');
  expect(s.push('nope!')).toBe('eyJhbnope!');
  expect(s.flush()).toBe('');
});

test('the environment for a model\'s command loses every secret variable but the passed ones', async () => {
  const { withheldEnv } = await import('../secrets.ts');
  const set = buildSecretSet({}, env);
  const { env: clean, withheld } = withheldEnv(env, set, ['SHORT_TOKEN']);
  expect(clean.WB_WIKI_TOKEN).toBeUndefined();
  expect(clean.SHORT_TOKEN).toBe('abc');
  expect(clean.PATH).toBe('/usr/bin:/bin');
  expect(withheld).toEqual(['WB_WIKI_TOKEN']);
});
