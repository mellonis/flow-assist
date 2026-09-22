// Tiny image files for the image tests: the bytes a sniffer reads — the magic and the
// header that carries the size — and nothing a decoder would need. The host never
// decodes an image; it tells what a file is and how big it is drawn.
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u16le = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

// `salt` makes two fixtures of the same size different files (a different hash).
export function png(width: number, height: number, salt = 0): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), ...ascii('IHDR'), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0, ...u32be(salt),
    ...u32be(0), ...ascii('IEND'), 0xae, 0x42, 0x60, 0x82,
  ]);
}

// An APP0 segment first, as a real JPEG has, so the size is found by walking segments.
export function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0x00, 0x11, 8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xd9,
  ]);
}

export function gif(width: number, height: number): Uint8Array {
  return new Uint8Array([...ascii('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0, 0x3b]);
}

export function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Uint8Array {
  const body = kind === 'VP8X'
    ? [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]
    : kind === 'VP8L'
      ? [0x2f, ...u32le(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14))]
      : [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)];
  return new Uint8Array([...ascii('RIFF'), ...u32le(4 + 8 + body.length), ...ascii('WEBP'), ...ascii(kind), ...u32le(body.length), ...body]);
}
