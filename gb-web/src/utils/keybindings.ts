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
