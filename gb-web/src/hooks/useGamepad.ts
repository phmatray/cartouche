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
  pressButton: (button: number) => void,
  releaseButton: (button: number) => void,
  active: boolean,
  onToggleFullscreen?: () => void,
) {
  const [connected, setConnected] = useState(() => !!navigator.getGamepads?.().some(Boolean));
  const prevButtonsRef = useRef<Record<number, boolean>>({});
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

    const gp = gamepads[0];
    if (!gp) return;

    const prev = prevButtonsRef.current;

    // Poll mapped buttons
    for (const [gpIdx, gbBtn] of Object.entries(GAMEPAD_MAP)) {
      const idx = Number(gpIdx);
      const pressed = gp.buttons[idx]?.pressed ?? false;
      const wasPressed = prev[idx] ?? false;

      if (pressed && !wasPressed) pressButton(gbBtn);
      if (!pressed && wasPressed) releaseButton(gbBtn);
      prev[idx] = pressed;
    }

    // Triangle (button 3) -> fullscreen toggle
    if (onToggleFullscreen) {
      const triPressed = gp.buttons[3]?.pressed ?? false;
      const triWas = prev[3] ?? false;
      if (triPressed && !triWas) onToggleFullscreen();
      prev[3] = triPressed;
    }

    // Poll left stick axes
    const prevAxes = prevAxesRef.current;
    for (const [key, mapping] of Object.entries(AXIS_MAP)) {
      const value = gp.axes[mapping.axis] ?? 0;
      const prevValue = prevAxes[key] ?? 0;

      const wasNeg = prevValue < -AXIS_DEADZONE;
      const wasPos = prevValue > AXIS_DEADZONE;
      const isNeg = value < -AXIS_DEADZONE;
      const isPos = value > AXIS_DEADZONE;

      if (isNeg && !wasNeg) pressButton(mapping.negative);
      if (!isNeg && wasNeg) releaseButton(mapping.negative);
      if (isPos && !wasPos) pressButton(mapping.positive);
      if (!isPos && wasPos) releaseButton(mapping.positive);

      prevAxes[key] = value;
    }
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
