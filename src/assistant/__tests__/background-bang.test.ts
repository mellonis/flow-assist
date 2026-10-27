import { expect, test } from 'bun:test';
import { backgroundCommand } from '../background-bang.ts';

test('a trailing unquoted & makes a background command, whatever the spacing', () => {
  expect(backgroundCommand('bun run dev &')).toBe('bun run dev');
  expect(backgroundCommand('bun run dev&')).toBe('bun run dev');
  expect(backgroundCommand('sleep 5 &   ')).toBe('sleep 5');
  expect(backgroundCommand('cd app && bun run dev &')).toBe('cd app && bun run dev');
  expect(backgroundCommand('a & b &')).toBe('a & b');
  expect(backgroundCommand('echo "x" &')).toBe('echo "x"');
});

test('&&, a middle &, an escaped & and a quoted & stay plain commands', () => {
  expect(backgroundCommand('a && b')).toBeNull();
  expect(backgroundCommand('a &&')).toBeNull();
  expect(backgroundCommand('a & b')).toBeNull();
  expect(backgroundCommand('echo a \\&')).toBeNull();
  expect(backgroundCommand('echo "a &"')).toBeNull();
  expect(backgroundCommand("echo 'a &'")).toBeNull();
  expect(backgroundCommand('echo "a \\" &"')).toBeNull();
  expect(backgroundCommand('echo "unclosed &')).toBeNull();
  expect(backgroundCommand('ls >&')).toBeNull();
  expect(backgroundCommand('&')).toBeNull();
  expect(backgroundCommand('')).toBeNull();
});

test('a quote closed before the & does not hide it, and a backslash before a quote is a plain character', () => {
  expect(backgroundCommand(`echo 'a' "b" &`)).toBe(`echo 'a' "b"`);
  expect(backgroundCommand("echo it\\'s &")).toBe("echo it\\'s");
  expect(backgroundCommand("echo 'a\\' &")).toBe("echo 'a\\'");
});
