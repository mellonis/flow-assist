import { expect, test } from 'bun:test';
import {
  TOOLS_LOAD, createToolSet, deferredTools, notLoadedError, runToolsLoad, toolIndex, toolLoadingMode, toolSummary, toolsToSend,
  type CatalogEntry,
} from '../tool-loading';

const def = (name: string, description = `${name} does a thing. More words here.`) =>
  ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', properties: {} } } });
const entry = (name: string, group: string): CatalogEntry => ({ name, group, def: def(name) });
const catalog: CatalogEntry[] = [
  entry('todo', 'core'), entry('ask_user', 'core'),
  entry('read_file', 'repo'), entry('list_dir', 'repo'),
  entry('get_issue', 'acme:aiTools'),
];
const names = (tools: { function: { name: string } }[]) => tools.map((t) => t.function.name);

test('only an explicit "all" turns tools on demand off', () => {
  expect(toolLoadingMode(undefined)).toBe('onDemand');
  expect(toolLoadingMode({})).toBe('onDemand');
  expect(toolLoadingMode({ toolLoading: 'onDemand' })).toBe('onDemand');
  expect(toolLoadingMode({ toolLoading: 'all' })).toBe('all');
});

test('a summary is the first sentence, flattened and capped', () => {
  expect(toolSummary('Read a file.\nIt returns text. Paths are relative.')).toBe('Read a file.');
  expect(toolSummary('No full stop at all')).toBe('No full stop at all');
  expect(toolSummary('v1.2 is a version. Next.')).toBe('v1.2 is a version.');
  const long = toolSummary('x'.repeat(300));
  expect(long.length).toBe(110);
  expect(long.endsWith('…')).toBe(true);
});

test('"all" sends every tool in full; on demand sends core, what is loaded, and the index', () => {
  const set = createToolSet();
  expect(names(toolsToSend(catalog, 'all', set))).toEqual(['todo', 'ask_user', 'read_file', 'list_dir', 'get_issue']);
  expect(names(toolsToSend(catalog, 'onDemand', set))).toEqual(['todo', 'ask_user', TOOLS_LOAD]);
  set.add(['read_file']);
  expect(names(toolsToSend(catalog, 'onDemand', set))).toEqual(['todo', 'ask_user', TOOLS_LOAD, 'read_file']);
});

test('a load only appends: what was sent before is, byte for byte, the head of what is sent after', () => {
  const set = createToolSet();
  let before = JSON.stringify(toolsToSend(catalog, 'onDemand', set)).slice(0, -1); // without the closing ]
  for (const n of ['get_issue', 'read_file', 'list_dir']) {
    set.add([n]);
    const after = JSON.stringify(toolsToSend(catalog, 'onDemand', set));
    expect(after.startsWith(before)).toBe(true);
    before = after.slice(0, -1);
  }
  // In the order they were loaded, not the catalog's.
  expect(names(toolsToSend(catalog, 'onDemand', set)).slice(3)).toEqual(['get_issue', 'read_file', 'list_dir']);
});

test('with nothing to defer, no tools_load is offered', () => {
  const onlyCore = catalog.filter((e) => e.group === 'core');
  expect(names(toolsToSend(onlyCore, 'onDemand', createToolSet()))).toEqual(['todo', 'ask_user']);
});

test('the index groups by plugin, one line per tool, and does not change as tools load', () => {
  const idx = toolIndex(deferredTools(catalog));
  expect(idx).toBe('repo:\n- read_file — read_file does a thing.\n- list_dir — list_dir does a thing.\nacme:\n- get_issue — get_issue does a thing.');
  const set = createToolSet();
  const indexOf = () => toolsToSend(catalog, 'onDemand', set).find((t) => t.function.name === TOOLS_LOAD)!.function.description;
  const before = indexOf();
  set.add(['read_file', 'get_issue']);
  expect(indexOf()).toBe(before);
});

test('tools_load takes names or a group, says what it did, and refuses what is not there', () => {
  const set = createToolSet();
  expect(runToolsLoad({ names: ['read_file'] }, catalog, set)).toBe('Loaded: read_file — call them now.');
  expect(runToolsLoad({ group: 'repo' }, catalog, set)).toBe('Loaded: list_dir — call them now. Already loaded: read_file.');
  expect(runToolsLoad({ names: ['get_issue', 'nope'] }, catalog, set)).toBe('Loaded: get_issue — call them now. Not in the list: nope.');
  expect(set.names()).toEqual(['read_file', 'list_dir', 'get_issue']);
  // Asking for what is always sent is not an error, and loads nothing.
  expect(runToolsLoad({ names: ['todo'] }, catalog, set)).toBe('Already loaded: todo.');
  expect(runToolsLoad({ group: 'core' }, catalog, set)).toBe('Already loaded: group "core".');
  expect(() => runToolsLoad({ names: ['nope'] }, catalog, set)).toThrow('Not in the list: nope. Groups: repo, acme.');
  expect(() => runToolsLoad({ group: 'nope' }, catalog, set)).toThrow('Not in the list: group "nope"');
  expect(() => runToolsLoad({}, catalog, set)).toThrow('Pass `names` or `group`');
  expect(set.names()).toEqual(['read_file', 'list_dir', 'get_issue']);
});

test('a group name passed in names loads that group, as `group` would', () => {
  const set = createToolSet();
  expect(runToolsLoad({ names: ['repo'] }, catalog, set)).toBe('Loaded: read_file, list_dir — call them now.');
  expect(set.names()).toEqual(['read_file', 'list_dir']);
  // Mixed with tool names, and with a name that is neither.
  const mixed = createToolSet();
  expect(runToolsLoad({ names: ['get_issue', 'repo', 'nope'] }, catalog, mixed))
    .toBe('Loaded: get_issue, read_file, list_dir — call them now. Not in the list: nope.');
  // The always-sent group, named in names, is not an error either.
  expect(runToolsLoad({ names: ['core'] }, catalog, createToolSet())).toBe('Already loaded: group "core".');
  expect(() => runToolsLoad({ names: ['nope'] }, catalog, createToolSet())).toThrow('Not in the list: nope. Groups: repo, acme.');
});

test('a name that is both a tool and a group stays the tool', () => {
  const clash: CatalogEntry[] = [...catalog, entry('repo', 'misc')];
  const set = createToolSet();
  expect(runToolsLoad({ names: ['repo'] }, clash, set)).toBe('Loaded: repo — call them now.');
  expect(set.names()).toEqual(['repo']);
});

test('a loaded set is saved as names and put back from them; anything else reads as empty', () => {
  const set = createToolSet();
  set.add(['a', 'b', 'a']);
  expect(set.names()).toEqual(['a', 'b']);
  const again = createToolSet();
  again.load(set.names());
  expect(again.has('b')).toBe(true);
  again.load(['c', 7, null, 'c']);
  expect(again.names()).toEqual(['c']);
  again.load('garbage');
  expect(again.names()).toEqual([]);
  set.reset();
  expect(set.names()).toEqual([]);
});

test('the not-loaded answer names tools_load and the tool', () => {
  expect(notLoadedError('read_file')).toBe('read_file is not loaded — call tools_load with names ["read_file"] first, then call it.');
});
