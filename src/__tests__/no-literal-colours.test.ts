// Drawing code names no colour of its own: every ink and ground comes from the
// resolved theme, so a palette (and a light scheme) reaches every surface. This scan
// reads the drawing sources and lists each string literal that is a named colour or a
// hex value. `default` is flowtty's "no colour" sentinel and is not a colour.
import { expect, test } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAMED_COLORS } from '@flowtty/core';

const ROOT = join(import.meta.dir, '..', '..');
const SCOPES = [
  'src/views/**/*.ts', 'src/views/**/*.tsx', 'src/runtime/**/*.tsx',
  'src/remote/**/*.ts', 'src/remote/**/*.tsx', 'src/plugins/**/*.ts', 'src/plugins/**/*.tsx',
];
const COLOUR = new Set<string>(NAMED_COLORS);
const HEX = /^#[0-9a-fA-F]{3,6}$/;

// The string literals of a source, comments skipped. Template literals are skipped
// whole: a colour is never written inside one.
export function stringLiterals(src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let line = 1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\n') line++;
    else if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; i--; }
    else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i++;
    } else if (c === '\'' || c === '"' || c === '`') {
      const start = i;
      const startLine = line;
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') { line++; if (c !== '`') break; }
      }
      if (c !== '`') out.push({ text: src.slice(start + 1, i), line: startLine });
    }
  }
  return out;
}

test('the scanner reads literals and skips comments', () => {
  const hits = stringLiterals("a('red') // 'blue'\n/* 'cyan' */ b(\"#fff\", `green ${x}`)").map((s) => s.text);
  expect(hits).toEqual(['red', '#fff']);
});

test('no drawing source names a colour', () => {
  const found: string[] = [];
  for (const pattern of SCOPES) {
    for (const rel of new Glob(pattern).scanSync({ cwd: ROOT })) {
      if (rel.includes('__tests__')) continue;
      for (const { text, line } of stringLiterals(readFileSync(join(ROOT, rel), 'utf8'))) {
        if (COLOUR.has(text) || HEX.test(text)) found.push(`${rel}:${line} '${text}'`);
      }
    }
  }
  expect(found).toEqual([]);
});
