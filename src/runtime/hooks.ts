// Host hooks. The runtime injects React primitives (`useState`, `useEffect`,
// `useRef`) plus the runtime's own `useInputHandler` into plugins via `ft`. This
// module holds the hooks that are HOST-owned — built on top of React but
// independent of the App component, so they can be imported and reused by
// `app.tsx` and tested in isolation.

import { useEffect, useRef, useState } from 'react';

// ─── Input handler processing ─────────────────────────────────────────────────
// The shape of a handler as the host registry stores it. `mode` is either
// 'observe' (sees every key without consuming) or 'consume' (joins the race).
type InputKey = { name?: string; [k: string]: unknown };
type UiState = { cmdOpen?: boolean; modalActive?: boolean };
type InputEntry = {
  mode: string;
  priority?: (ui: UiState) => number;
  handler: (key: InputKey, ui: UiState) => unknown;
};
// A registry entry: either a resolved handler, or a lazy `{ get }` wrapper (the
// App stores handlers behind `get: () => ref.current` so the handler is always
// read fresh — no stale closure).
export type LazyInputEntry = InputEntry | { get: () => InputEntry };

export interface InputHandlerOpts {
  mode?: string;
  priority?: (ui: UiState) => number;
  handler: (key: InputKey, ui: UiState) => unknown;
}

// Registers an input handler into the App's registry. A React hook: it keeps a
// ref (so the handler is always the freshest closure) and subscribes it on mount
// (cleanup unsubscribes on unmount). Plugins call this (via `ft.useInputHandler`)
// from their own component render, so a plugin component owns its handler
// lifecycle. Registration is keyed-by-identity, not re-registered on re-render.
export function registerInputHandler(
  inputRegistryRef: { current: LazyInputEntry[] },
  { mode = 'consume', priority = () => 0, handler }: InputHandlerOpts,
): void {
  const ref = useRef<InputEntry>({ mode, priority, handler });
  ref.current = { mode, priority, handler };
  useEffect(() => {
    const entry: LazyInputEntry = { get: () => ref.current };
    inputRegistryRef.current.push(entry);
    return () => {
      inputRegistryRef.current = inputRegistryRef.current.filter((e) => e !== entry);
    };
  }, []);
}

// ─── Transient message (bottom line toast) ────────────────────────────────────
// The bottom line shows either the command line, a transient notification, or the
// footer hints. `useToast` provides the transient message: it auto-clears after
// `TOAST_MS` (a single pending timer, cleared on the next show / unmount). The
// duration is a parameter so a test can watch a toast go without waiting seconds.
export const TOAST_MS = 4000;

export interface Toast {
  message: string | null;
  setMessage: (msg: string | null) => void;
  showMessage: (msg: string) => void;
}

export function useToast(ms: number = TOAST_MS): Toast {
  const [message, setMessage] = useState<string | null>(null);
  const messageRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showMessage: (msg: string) => void = (text) => {
    setMessage(text);
    if (messageRef.current) clearTimeout(messageRef.current);
    messageRef.current = setTimeout(() => setMessage(null), ms);
  };
  useEffect(() => () => {
    if (messageRef.current) clearTimeout(messageRef.current);
  }, []);
  return { message, setMessage, showMessage };
}