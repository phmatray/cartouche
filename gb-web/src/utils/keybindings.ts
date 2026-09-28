export const KEY_MAP: Record<string, number> = {
  ArrowUp: 6,    // Up
  ArrowDown: 7,  // Down
  ArrowLeft: 5,  // Left
  ArrowRight: 4, // Right
  z: 0,          // A
  x: 1,          // B
  Enter: 3,      // Start
  Shift: 2,      // Select
};

export const BUTTON_NAMES: Record<number, string> = {
  0: 'A',
  1: 'B',
  2: 'Select',
  3: 'Start',
  4: 'Right',
  5: 'Left',
  6: 'Up',
  7: 'Down',
};

export const BUTTON_NUMBERS: Record<string, number> = {
  A: 0,
  B: 1,
  Select: 2,
  Start: 3,
  Right: 4,
  Left: 5,
  Up: 6,
  Down: 7,
};

/**
 * A shortcut chord (Ctrl, ⌘ or Alt with another key): the browser's and the system's, not the game's. The modifier on
 * its own is a key like any other (a button can be bound to Control), though its own keydown carries its flag.
 */
export const chord = (e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>) =>
  (e.ctrlKey && e.key !== 'Control') || (e.metaKey && e.key !== 'Meta') || (e.altKey && e.key !== 'Alt' && e.key !== 'AltGraph');

// A button is bound to a physical key (KeyboardEvent.code), a modifier without its side: 'KeyZ', 'Digit1', 'Shift'. The
// same key then plays whatever Shift does to its character, and on any layout. A binding saved before codes is the
// character typed ('z'): it matches by character until the keyboard says which key types it (resolve, learn).
type Key = Pick<KeyboardEvent, 'key' | 'code'>;
type Bindings = Record<string, string>;
/** The binding a key press is: its code, Shift for either Shift (Control, Alt, Meta likewise). */
export const codeOf = (e: Pick<KeyboardEvent, 'code'>) => e.code.replace(/^(Shift|Control|Alt|Meta)(Left|Right)$/, '$1');
/** A binding saved before codes: one character. */
const legacy = (k: string) => k.length === 1;
const typed = (e: Key) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);

/** Whether key press `e` is the key `binding` names: by code, or by character for a binding saved before codes. */
export const isKey = (binding: string, e: Key) => binding === codeOf(e) || binding === typed(e);

/** What a keydown binds a button to, or null: a dead key (an accent waiting for its letter), or one with no code. */
export const bindable = (e: Key): string | null => (e.key === 'Dead' || !e.code ? null : codeOf(e));

/**
 * The bindings with each character saved before codes turned into the key that types it on this keyboard (`layout`:
 * navigator.keyboard.getLayoutMap(), code → character typed without Shift), or null when none changed. A character
 * the layout doesn't type without Shift ('!') stays, until `learn`.
 */
export function resolve<T extends Bindings>(bindings: T, layout: Iterable<[string, string]>): T | null {
  const codes = new Map<string, string>();
  for (const [code, ch] of layout) if (!codes.has(ch.toLowerCase())) codes.set(ch.toLowerCase(), code);
  const out = Object.fromEntries(Object.entries(bindings).map(([b, k]) => [b, (legacy(k) && codes.get(k)) || k])) as T;
  return Object.keys(out).some((b) => out[b] !== bindings[b]) ? out : null;
}

/**
 * The bindings with the character saved before codes that key press `e` types turned into its key, or null. Only a
 * press Shift left alone: Shift + 1 types '!' on a US keyboard, but the key bound to '!' is where '!' is typed alone.
 */
export function learn<T extends Bindings>(bindings: T, e: Key & Pick<KeyboardEvent, 'shiftKey'>): T | null {
  if (e.shiftKey || !e.code) return null;
  const hit = Object.keys(bindings).find((b) => legacy(bindings[b]) && bindings[b] === typed(e));
  return hit ? { ...bindings, [hit]: codeOf(e) } : null;
}

// The US keyboard's characters by code, to label a key where the browser can't say what this keyboard types.
const US = '`1234567890-=qwertyuiop[]\\asdfghjkl;\'zxcvbnm,./';
const keys = (s: string, p: string) => [...s].map((c) => p + c);
const CODES = ['Backquote', ...keys('1234567890', 'Digit'), 'Minus', 'Equal', ...keys('QWERTYUIOP', 'Key'), 'BracketLeft', 'BracketRight',
  'Backslash', ...keys('ASDFGHJKL', 'Key'), 'Semicolon', 'Quote', ...keys('ZXCVBNM', 'Key'), 'Comma', 'Period', 'Slash'];

/** The character a code types on a US keyboard ('Digit1' → '1'), for a label where the browser can't say. */
export const usChar = (code: string): string | undefined => US[CODES.indexOf(code)];
