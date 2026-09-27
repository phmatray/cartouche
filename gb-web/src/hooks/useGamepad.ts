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

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => {
      setConnected(false);
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

    // The first connected gamepad is player 1; the next ones are Super Game Boy players 2-4 (ignored elsewhere).
    [...gamepads].filter((g) => g !== null).slice(0, 4).forEach((gp, player) => {
      const prev = prevButtonsRef.current;
      const k = (i: number | string) => (player ? `${player}:${i}` : String(i));
      const press = (b: number) => pressButton(b, player), release = (b: number) => releaseButton(b, player);

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
        if (triPressed && !triWas) onToggleFullscreen();
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
