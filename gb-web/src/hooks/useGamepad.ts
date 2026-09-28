import { useEffect, useRef, useCallback, useState } from 'react';

/** Standard Gamepad API button indices -> Game Boy button numbers */
const GAMEPAD_MAP: Record<number, number> = {
  0: 0,   // Cross/A -> A
  1: 1,   // Circle/B -> B
  8: 2,   // Share/Create -> Select
  9: 3,   // Options -> Start
  12: 6,  // D-pad Up -> Up
  13: 7,  // D-pad Down -> Down
  14: 5,  // D-pad Left -> Left
  15: 4,  // D-pad Right -> Right
};

const AXIS_DEADZONE = 0.5;
const AXIS_MAP = {
  leftX: { axis: 0, negative: 5, positive: 4 },
  leftY: { axis: 1, negative: 6, positive: 7 },
};

/**
 * What the pads still hold, from the last poll (keys: `12` for player 1, `2:12` for player 3; the stick as
 * `leftX`/`2:leftX`), as [Game Boy button, player] pairs. A pad that goes away never sends its releases.
 */
export function heldBy(buttons: Record<string, boolean>, axes: Record<string, number>): [number, number][] {
  const held: [number, number][] = [];
  const split = (key: string) => { const [a, b] = key.split(':'); return b === undefined ? [0, a] as const : [Number(a), b] as const; };
  for (const [key, on] of Object.entries(buttons)) {
    const [player, i] = split(key);
    const b = GAMEPAD_MAP[Number(i)];
    if (on && b !== undefined) held.push([b, player]);
  }
  for (const [key, v] of Object.entries(axes)) {
    const [player, name] = split(key);
    const m = AXIS_MAP[name as keyof typeof AXIS_MAP];
    if (m && v < -AXIS_DEADZONE) held.push([m.negative, player]);
    if (m && v > AXIS_DEADZONE) held.push([m.positive, player]);
  }
  return held;
}

export function useGamepad(
  pressButton: (button: number, player?: number) => void,
  releaseButton: (button: number, player?: number) => void,
  active: boolean,
  onToggleFullscreen?: () => void,
) {
  const [connected, setConnected] = useState(() => !!navigator.getGamepads?.().some(Boolean));
  const prevButtonsRef = useRef<Record<string, boolean>>({});
  const prevAxesRef = useRef<Record<string, number>>({});
  const rafRef = useRef<number>(0);
  const releaseRef = useRef(releaseButton);
  useEffect(() => { releaseRef.current = releaseButton; }, [releaseButton]);

  const quietRef = useRef(true); // first poll after (re)starting: note what is held, press nothing

  // Paused or unloaded: let go of what the pad holds (its release would never reach the game), and start afresh.
  useEffect(() => () => {
    const who = (k: string) => (k.includes(':') ? [Number(k.split(':')[0]), k.split(':')[1]] as const : [0, k] as const);
    for (const [k, on] of Object.entries(prevButtonsRef.current)) {
      const [p, i] = who(k);
      if (on && GAMEPAD_MAP[+i] !== undefined) releaseButton(GAMEPAD_MAP[+i], p);
    }
    for (const [k, v] of Object.entries(prevAxesRef.current)) {
      const [p, a] = who(k), m = AXIS_MAP[a as keyof typeof AXIS_MAP];
      if (m && Math.abs(v) > AXIS_DEADZONE) releaseButton(v < 0 ? m.negative : m.positive, p);
    }
    prevButtonsRef.current = {};
    prevAxesRef.current = {};
    quietRef.current = true;
  }, [active, releaseButton]);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = (e: GamepadEvent) => {
      // Another pad still plugged in (Super Game Boy players) keeps playing.
      setConnected(!!navigator.getGamepads?.().some((g) => g && g.index !== e.gamepad.index));
      // A pad that sleeps or runs flat mid-press: let go of what it held, as on blur.
      for (const [b, player] of heldBy(prevButtonsRef.current, prevAxesRef.current)) releaseRef.current(b, player);
      prevButtonsRef.current = {};
      prevAxesRef.current = {};
    };

    window.addEventListener('gamepadconnected', onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);

    return () => {
      window.removeEventListener('gamepadconnected', onConnect);
      window.removeEventListener('gamepaddisconnected', onDisconnect);
    };
  }, []);

  const poll = useCallback(() => {
    if (!active) return;

    const gamepads = navigator.getGamepads?.();
    if (!gamepads) return;
    // A button still down from the menus (A on Play) doesn't reach the game: only presses made from now on.
    // Nor a press made in a dialog over the game (useGamepadNav gives it the pad), until the poll after it closed: the
    // A that answered it may have closed it earlier this frame. A release always counts.
    const dialog = !!document.querySelector('dialog[open]');
    const quiet = quietRef.current || dialog;
    quietRef.current = dialog;

    // The first connected gamepad is player 1; the next ones are Super Game Boy players 2-4 (ignored elsewhere).
    [...gamepads].filter((g) => g !== null).slice(0, 4).forEach((gp, player) => {
      const prev = prevButtonsRef.current;
      const k = (i: number | string) => (player ? `${player}:${i}` : String(i));
      const press = (b: number) => { if (!quiet) pressButton(b, player); }, release = (b: number) => releaseButton(b, player);

      // Poll mapped buttons
      for (const [gpIdx, gbBtn] of Object.entries(GAMEPAD_MAP)) {
        const idx = Number(gpIdx);
        const pressed = gp.buttons[idx]?.pressed ?? false;
        const wasPressed = prev[k(idx)] ?? false;

        if (pressed && !wasPressed) press(gbBtn);
        if (!pressed && wasPressed) release(gbBtn);
        prev[k(idx)] = pressed;
      }

      // Triangle (button 3) -> fullscreen toggle
      if (onToggleFullscreen && !player) {
        const triPressed = gp.buttons[3]?.pressed ?? false;
        const triWas = prev[3] ?? false;
        if (triPressed && !triWas && !quiet) onToggleFullscreen();
        prev[3] = triPressed;
      }

      // Poll left stick axes
      const prevAxes = prevAxesRef.current;
      for (const [key, mapping] of Object.entries(AXIS_MAP)) {
        const value = gp.axes[mapping.axis] ?? 0;
        const prevValue = prevAxes[k(key)] ?? 0;

        const wasNeg = prevValue < -AXIS_DEADZONE;
        const wasPos = prevValue > AXIS_DEADZONE;
        const isNeg = value < -AXIS_DEADZONE;
        const isPos = value > AXIS_DEADZONE;

        if (isNeg && !wasNeg) press(mapping.negative);
        if (!isNeg && wasNeg) release(mapping.negative);
        if (isPos && !wasPos) press(mapping.positive);
        if (!isPos && wasPos) release(mapping.positive);

        prevAxes[k(key)] = value;
      }
    });
  }, [active, pressButton, releaseButton, onToggleFullscreen]);

  useEffect(() => {
    if (!active || !connected) return;

    const loop = () => {
      poll();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, connected, poll]);

  return { connected };
}
