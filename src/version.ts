// The host's version. It must equal the `version` in package.json — a test holds
// the two together — and CHANGELOG.md says what each version brought.
export function hostVersion(): string {
  return '0.1.0';
}

// What the host gives plugins, as one number: the object each plugin hook receives,
// the services on it, the plugin shape's hooks and their signatures, the manifest's
// fields. It goes up on any change a plugin built for the previous number would break
// on; a plugin declares the numbers it works with (`hostApi` in its manifest.json) and
// is not loaded under any other (src/loader/compat.ts, docs/plugins.md "Compatibility").
export const HOST_API = 2;

// The flowtty the host runs and hands plugins: a plugin's manifest names the flowtty
// versions it needs (`flowtty`, a semver range) and is checked against this. It must
// equal the installed `@flowtty/react` — a test holds the two together; a compiled
// binary has no node_modules to read it from.
export const FLOWTTY_VERSION = '1.0.0-alpha.28';
