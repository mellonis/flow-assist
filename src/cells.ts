// Widths of the host's own chrome, in terminal cells.
//
// flowtty's grid draws text per grapheme cluster (under the width policy the backend
// sets), so every width the host sums or cuts to — a chat row, a title, a padded
// column — is measured by @flowtty/core's own functions, here, and never by a
// per-code-point or per-UTF-16 count: a flag or a ZWJ sequence is one cluster of two
// cells, and counted any other way a cut lands early or a column comes out short.

import { fitClusters, graphemes, stringWidth } from '@flowtty/core';

// How many terminal cells a string takes, measured as the grid draws it: per
// grapheme cluster, so a wide character, a flag or a ZWJ sequence takes two. Every
// width the chat's chrome sums goes through this, never through a per-code-point sum.
export function cellWidth(text: string): number {
  return stringWidth(String(text ?? ''));
}

// A line of chrome takes exactly ONE terminal row, so what does not fit is cut with an
// ellipsis rather than wrapped — by the cells it takes, whole clusters only, so a cut
// never leaves half a flag or a dangling joiner.
export function cutStep(text: string, width: number): string {
  const str = String(text ?? '');
  if (width <= 0) return '';
  if (stringWidth(str) <= width) return str;
  const clusters = graphemes(str);
  return `${clusters.slice(0, fitClusters(clusters, width - 1)).join('')}…`;
}
