// Plugin identity tokens. The HOST issues every plugin a unique Symbol and is
// the only party that holds the token→name map (the memory tool resolves a
// `plugin` scope through it). A Symbol is a unique, unforgeable object: a plugin
// may relay its OWN token (proving who it is) but can never fabricate another
// plugin's token, so a caller injecting a raw plugin-name string into toolCtx
// does nothing — only a real host-issued token maps to a name.
//
// Design note (2026-09-20): the previous scheme relayed a string `pluginName`
// from the plugin into toolCtx, which the plugin could freely spoof. The Symbol
// closes that: identity is unforgeable rather than merely host-declared.

const tokenToName = new Map<symbol, string>();
const nameToToken = new Map<string, symbol>();

// Returns a stable identity token for a plugin name (same name → same token, so a
// plugin always presents the same identity and the token↔name maps agree).
export function identityToken(name: string): symbol {
  let t = nameToToken.get(name);
  if (!t) {
    t = Symbol(`plugin:${name}`);
    nameToToken.set(name, t);
    tokenToName.set(t, name);
  }
  return t;
}

// Maps a host-issued token back to the owning plugin name. Returns undefined for
// anything that is not one of OUR tokens (a forged/dangling Symbol, or a token we
// never issued) — the caller cannot get a name for an identity it does not hold.
export function resolveIdentityToken(token: symbol): string | undefined {
  return tokenToName.get(token);
}