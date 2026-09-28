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

/** What goes down and up between two polls' `heldBy`, each [Game Boy button, player] once. */
export function changes(before: [number, number][], after: [number, number][]) {
  const key = ([b, p]: [number, number]) => `${p}:${b}`;
  const was = new Map(before.map((x) => [key(x), x])), now = new Map(after.map((x) => [key(x), x]));
  return { press: [...now].filter(([k]) => !was.has(k)).map(([, x]) => x), release: [...was].filter(([k]) => !now.has(k)).map(([, x]) => x) };
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
    for (const [b, p] of heldBy(prevButtonsRef.current, prevAxesRef.current)) releaseButton(b, p);
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

    const prev = prevButtonsRef.current, prevAxes = prevAxesRef.current;
    const before = heldBy(prev, prevAxes);
    // The first connected gamepad is player 1; the next ones are Super Game Boy players 2-4 (ignored elsewhere).
    [...gamepads].filter((g) => g !== null).slice(0, 4).forEach((gp, player) => {
      const k = (i: number | string) => (player ? `${player}:${i}` : String(i));
      for (const idx of Object.keys(GAMEPAD_MAP)) prev[k(idx)] = gp.buttons[+idx]?.pressed ?? false;
      // Triangle (button 3) -> fullscreen toggle
      if (onToggleFullscreen && !player) {
        const triPressed = gp.buttons[3]?.pressed ?? false;
        if (triPressed && !prev[3] && !quiet) onToggleFullscreen();
        prev[3] = triPressed;
      }
      for (const [key, mapping] of Object.entries(AXIS_MAP)) prevAxes[k(key)] = gp.axes[mapping.axis] ?? 0;
    });
    // By Game Boy button: the D-pad and the stick both hold Right, and Right goes up only once neither does.
    const { press, release } = changes(before, heldBy(prev, prevAxes));
    for (const [b, player] of release) releaseButton(b, player);
    if (!quiet) for (const [b, player] of press) pressButton(b, player);
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
