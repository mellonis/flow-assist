// Canvas plugin skeleton — the builder only: no surface, no tools yet.
// `keycaps` returns `[]` so the host never mounts a surface of the plugin's
// (docs/plugins.md, "Screens").
// `Make` mirrors the host's `make(name, shape)` (src/loader/plugin.ts): it fills the
// name, the plugin's config slice and its keys into the shape the builder returns.
// It is restated here — a plugin's typechecked sources stay under its own rootDir.
type Make = (name: string, shape: Record<string, unknown>) => Record<string, unknown>;

export default function buildCanvasPlugin({ config, make, z }: { config?: unknown; make: Make; z: unknown }): unknown {
  return make('canvas', { name: 'canvas', keycaps: () => [] });
}
