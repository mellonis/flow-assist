// A sign-in form as a remote plugin — the example docs/plugins.md walks through under
// "A plugin in another language". The host draws; this process keeps the model and
// sends a frame after every change. Run by the host: `run: ["bun", "src/index.ts"]`.
import { runPlugin, type HostEvent } from '@flow-assist/remote';

type Model = { name: string; pass: string; focus: 'name' | 'pass' | 'login'; note: string; open: boolean };

const next = (f: Model['focus']): Model['focus'] => (f === 'name' ? 'pass' : f === 'pass' ? 'login' : 'name');

await runPlugin<Model, HostEvent>({
  hello: { name: 'remote-login', keys: { open: 'S', next: 'tab', login: 'enter', close: 'esc' }, entry: ['open'] },
  init: () => ({ name: '', pass: '', focus: 'name', note: '', open: false }),
  update: async (e, m, host) => {
    switch (e.type) {
      case 'key':
        if (e.key.action === 'open' && !m.open) return { ...m, open: true };
        if (!m.open) return m;
        if (e.key.action === 'next') return { ...m, focus: next(m.focus) };
        if (e.key.action === 'close') return { ...m, open: false };
        if (e.key.action === 'login' && m.focus === 'login') {
          if (!m.name || !m.pass) return { ...m, note: 'both fields are required' };
          await host.showMessage('Signed in');
          return { ...m, note: `signed in as ${m.name}` };
        }
        return m;
      case 'changed': return e.id === 'name' ? { ...m, name: String(e.value ?? '') } : e.id === 'pass' ? { ...m, pass: String(e.value ?? '') } : m;
      case 'submitted': return { ...m, focus: 'login' };
      default: return m;
    }
  },
  view: (m) => (!m.open
    ? { surface: null, keycaps: [], keys: { consume: ['open'] } }
    : {
        surface: ['Box', { flexDirection: 'column', padding: 1 },
          ['Text', { bold: true }, 'Sign in'],
          ['Text', { dim: true }, 'Name'], ['TextInput', { id: 'name', isFocused: m.focus === 'name' }],
          ['Text', { dim: true }, 'Password'], ['TextInput', { id: 'pass', mask: true, isFocused: m.focus === 'pass' }],
          ['Text', { inverse: m.focus === 'login' }, '[ Log in ]'],
          ['Text', { dim: true }, m.note]],
        keycaps: [{ action: 'open', label: 'form' }, { action: 'next', label: 'next' }, { action: 'login', label: 'log in' }, { action: 'close', label: 'close' }],
        context: [{ label: 'Sign in', text: `name: ${m.name || '(empty)'} · focus: ${m.focus}` }],
        keys: { consume: ['open', 'next', 'login', 'close'] },
      }),
});
