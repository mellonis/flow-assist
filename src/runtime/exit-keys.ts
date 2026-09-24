// Ctrl+C, Ctrl+D and Ctrl+Z take a second press (pure; the App owns the state).
//
// flowtty hands these three to the app before the terminal backend acts on them —
// Ctrl+C / Ctrl+D exit and Ctrl+Z suspends unless a handler consumes the key. One
// accidental press would otherwise end the app in the middle of an answer, or stop it
// with a request in flight. So the first press ARMS (and is consumed), and says so; the same
// key again within `ARM_MS` does what the key means; any other key disarms.

import { keyGlyph } from '../playback/keys.js';

export type ArmKey = 'c' | 'd' | 'z';
export type Arm = { key: ArmKey; at: number } | null;

// How long an armed key waits for its second press.
export const ARM_MS = 2000;

// The key as one of the three, or null. Alt or Shift held with it is another key.
export function armKeyOf(key: { name?: string; ctrl?: unknown; meta?: unknown; shift?: unknown }): ArmKey | null {
  if (!key.ctrl || key.meta || key.shift) return null;
  return key.name === 'c' || key.name === 'd' || key.name === 'z' ? key.name : null;
}

// One press of an arm key: arm it, or — the same key again in time — fire.
export function armStep(arm: Arm, key: ArmKey, now: number): { arm: Arm; fire: boolean } {
  if (arm && arm.key === key && now - arm.at < ARM_MS) return { arm: null, fire: true };
  return { arm: { key, at: now }, fire: false };
}

// What the status line says while a key is armed: `^c again to exit`.
export function armHint(arm: Arm): string {
  if (!arm) return '';
  return `${keyGlyph({ name: arm.key, ctrl: true })} again to ${arm.key === 'z' ? 'suspend' : 'exit'}`;
}
