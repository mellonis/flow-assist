// The person's language for `hello.locale`, read the way gettext reads the
// environment: `FLOW_ASSIST_LOCALE` first (host variables carry that prefix), then
// `LC_ALL`, `LC_MESSAGES`, `LANG`; the first non-empty wins. `C` and `POSIX` mean no
// language. A POSIX spelling becomes a BCP 47 tag: `ru_RU.UTF-8` → `ru-RU`, the
// encoding and a `@modifier` dropped. Absent when nothing says a language — the
// host's own UI is English throughout and has no setting of its own.
export function localeFromEnv(env: Record<string, string | undefined>): string | undefined {
  for (const name of ['FLOW_ASSIST_LOCALE', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    if (raw === 'C' || raw === 'POSIX') return undefined;
    const base = raw.split('.')[0]!.split('@')[0]!;
    const m = /^([a-z]{2,3})(?:[_-]([A-Za-z]{2,4}))?$/.exec(base);
    if (!m) return undefined;
    return m[2] ? `${m[1]}-${m[2].toUpperCase()}` : m[1]!;
  }
  return undefined;
}
