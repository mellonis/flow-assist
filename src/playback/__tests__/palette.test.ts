// The palette model: 16 base roles per scheme, surface keys that may reference a
// role as `${base.<role>}`, and the resolution of both.
import { expect, test } from 'bun:test';
import {
  ROLES,
  SCHEMES,
  expand,
  isRef,
  layer,
  provenance,
  resolveSurface,
  type Role,
  type SchemeModel,
} from '../palette';

const base = Object.fromEntries(ROLES.map((r, i) => [r, `#00000${(i % 10).toString()}`])) as Record<Role, string>;

function model(): SchemeModel {
  return {
    base: { ...base, border: '${base.muted}', muted: '#4c4c4c' },
    surfaces: {
      chat: { userBg: '#112233', askBg: '${base.bg}' },
      status: { text: '#abcdef' },
    },
  };
}

test('ROLES lists the 16 roles in order and SCHEMES the two schemes', () => {
  expect(ROLES.join(' ')).toBe(
    'bg text muted border accent selected highlight danger ok warn fieldBg fieldText fieldBorder panelBg highlightStrong highlightText',
  );
  expect([...SCHEMES]).toEqual(['dark', 'light']);
});

test('isRef names the role of a base reference, anything else is null', () => {
  expect(isRef('${base.bg}')).toBe('bg');
  expect(isRef('${base.nope}')).toBeNull();
  expect(isRef('#fff')).toBeNull();
  expect(isRef('x ${base.bg}')).toBeNull();
});

test('expand follows a two-hop ref', () => {
  expect(expand(model().base, '${base.border}')).toBe('#4c4c4c');
  expect(expand(model().base, '#123456')).toBe('#123456');
});

test('expand returns the value as written on a cycle or an unknown ref', () => {
  const cyc = { ...base, bg: '${base.text}', text: '${base.bg}' };
  expect(expand(cyc, cyc.bg)).toBe('${base.text}');
  expect(expand(base, '${base.nope}')).toBe('${base.nope}');
});

test('resolveSurface returns every role plus the surface keys, refs expanded', () => {
  const m = model();
  const out = resolveSurface(m, 'chat');
  expect(Object.keys(out)).toEqual(expect.arrayContaining([...ROLES, 'userBg', 'askBg']));
  expect(out.border).toBe('#4c4c4c');
  expect(out.userBg).toBe('#112233');
  expect(out.askBg).toBe(base.bg);
  expect(resolveSurface(m, 'missing').bg).toBe(base.bg);
});

test('layer lays overrides on defaults and leaves the rest untouched', () => {
  const m = model();
  const next = layer(m, { chat: { userBg: '#010203' } });
  expect(next.surfaces.chat).toEqual({ userBg: '#010203', askBg: '${base.bg}' });
  expect(next.base).toEqual(m.base);
  expect(next.surfaces.status).toEqual(m.surfaces.status);
  expect(m.surfaces.chat.userBg).toBe('#112233');
  expect(layer(m, { base: { bg: '#fff' } }).base.bg).toBe('#fff');
  expect(layer(m, { fresh: { k: 'v' } }).surfaces.fresh).toEqual({ k: 'v' });
});

test('provenance: an override is own, a default ref inherits from its role', () => {
  const d = model();
  const e = layer(d, { chat: { userBg: '#010203' } });
  expect(provenance(d, e, 'chat', 'userBg')).toEqual({ value: '#010203', source: 'own' });
  expect(provenance(d, e, 'chat', 'askBg')).toEqual({ value: base.bg, source: 'inherit', from: 'bg' });
  // a key the surface does not set inherits from the base role of the same name
  expect(provenance(d, e, 'chat', 'text')).toEqual({ value: base.text, source: 'inherit', from: 'text' });
  // a new key set only by the person is own
  expect(provenance(d, layer(d, { chat: { extra: '#111111' } }), 'chat', 'extra').source).toBe('own');
});

test('provenance on base rows', () => {
  const d = model();
  expect(provenance(d, d, null, 'border')).toEqual({ value: '#4c4c4c', source: 'inherit', from: 'muted' });
  expect(provenance(d, d, null, 'muted')).toEqual({ value: '#4c4c4c', source: 'own' });
  const e = layer(d, { base: { border: '#999999' } });
  expect(provenance(d, e, null, 'border')).toEqual({ value: '#999999', source: 'own' });
});
