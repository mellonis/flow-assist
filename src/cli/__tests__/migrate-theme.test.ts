import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { acceptedConfigPath, hostStateDir, loadConfig, resetSessionConfig } from '../../config/load';

const local = () => path.join(hostStateDir(), 'config.local.json');
const base = () => path.join(hostStateDir(), 'config.json');

const OLD = {"theme":{"modals":{"bg":"black","border":"cyan","borderBg":"black","text":"white","selected":"green","fieldBg":"gray","fieldBorder":"cyan"},"selected":"green","error":"red","success":"green","panelBg":"#1a1b26","highlightBg":"#3c3c3c","accentBg":"#20456b","highlightText":"white","canvas":{"modals":{"bg":"black"},"selected":"yellow"}},"plugins":{"chat":{"colors":{"userBg":"#232323","accent":"#fab283"}}}};

const kept = new Map<string, string | null>();
beforeEach(() => {
  for (const f of [local(), base()]) kept.set(f, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  fs.rmSync(acceptedConfigPath(), { force: true });
});
afterEach(() => {
  resetSessionConfig();
  for (const [f, v] of kept) { if (v === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, v); }
  fs.rmSync(acceptedConfigPath(), { force: true });
  process.exitCode = 0;
});

async function run(): Promise<string[]> {
  const { runConfig } = await import('../../main');
  const out: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`err: ${l}`) };
  await runConfig(['migrate-theme'], loadConfig({ session: false }), undefined, io);
  return out;
}

test('migrate-theme moves the old keys of config.local.json into theme.dark, one line per key', async () => {
  fs.mkdirSync(hostStateDir(), { recursive: true });
  fs.rmSync(base(), { force: true });
  fs.writeFileSync(local(), JSON.stringify(OLD));
  const lines = await run();
  expect(lines).toContain('set theme.dark.chat.userBg #232323');
  expect(lines).toContain('set theme.dark.chat.accent #fab283');
  expect(lines).toContain('unset theme.modals');
  expect(lines).toContain('unset plugins.chat.colors');
  expect(lines).toContain('dropped theme.canvas (a resolved palette, not an override)');
  const written = JSON.parse(fs.readFileSync(local(), 'utf8'));
  expect(written.theme).toEqual({ dark: { chat: { userBg: '#232323', accent: '#fab283' } } });
  expect(written.plugins?.chat?.colors).toBeUndefined();
  // Done once: the second run finds nothing.
  expect(await run()).toEqual(['nothing to migrate']);
});

test('old keys in config.json are left alone and said so; the new values are still saved', async () => {
  fs.mkdirSync(hostStateDir(), { recursive: true });
  fs.writeFileSync(local(), '{}');
  fs.writeFileSync(base(), JSON.stringify(OLD));
  const before = fs.readFileSync(base(), 'utf8');
  const lines = await run();
  expect(lines).toContain('set theme.dark.chat.userBg #232323');
  expect(lines.some((l) => l.includes('theme.modals') && l.includes('config.json') && !l.startsWith('unset'))).toBe(true);
  expect(lines).not.toContain('unset theme.modals');
  expect(fs.readFileSync(base(), 'utf8')).toBe(before);
});

test('migrate-theme with no old keys says there is nothing to do', async () => {
  fs.mkdirSync(hostStateDir(), { recursive: true });
  fs.writeFileSync(local(), '{}');
  fs.rmSync(base(), { force: true });
  expect(await run()).toEqual(['nothing to migrate']);
});
