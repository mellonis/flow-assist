// The colour the host draws for a key by default, resolved from its own palette:
// tests compare against this rather than restating the palette's values.
import { HOST_PALETTE } from '../../playback/palette-defaults.js';
import { resolveSurface } from '../../playback/palette.js';

export function hostColour(scheme: 'dark' | 'light', surface: string, key: string): string {
  const value = resolveSurface(HOST_PALETTE[scheme], surface)[key];
  if (value === undefined) throw new Error(`no ${scheme} ${surface}.${key} in the host palette`);
  return value;
}
