// Tilt for MBC7 cartridges, in g as the core's `set_tilt(x, y)` takes it:
// x > 0 = the right side of the screen down, y > 0 = the top side down (away from the player).
// Pure math: the dock and the frame loop feed it sensor readings, stick axes and held keys.

export interface Tilt { x: number; y: number }
export type ScreenAngle = 0 | 90 | 180 | 270;
export type TiltSource = 'motion' | 'pad' | 'keys';

const G = 9.81;
const DEADZONE = 0.15;
const KEY_G = 0.6;
const KEY_RAMP_MS = 250;
const MAX_G = 2;

/** Keys that tilt (lowercase `KeyboardEvent.key`), unless a Game Boy button is bound to them. */
export const TILT_KEYS = { i: 'up', j: 'left', k: 'down', l: 'right' } as const;

/**
 * DeviceMotion `accelerationIncludingGravity` (m/s², device axes, W3C sign: a phone lying flat reads
 * z = +9.81) to screen-aligned tilt, minus the recenter offset. The reading points away from gravity,
 * so a side tilted down reads negative; `screenAngle` is `screen.orientation.angle`.
 * ponytail: W3C sign only; if a browser reports it inverted, add a flip setting.
 */
export function motionToTilt(a: { x: number; y: number; z: number }, screenAngle: ScreenAngle, offset: Tilt): Tilt {
  const dx = -a.x / G, dy = -a.y / G;
  const [x, y] = screenAngle === 90 ? [-dy, dx] : screenAngle === 180 ? [-dx, -dy] : screenAngle === 270 ? [dy, -dx] : [dx, dy];
  return { x: x - offset.x, y: y - offset.y };
}

/** DeviceOrientation angles (degrees) as the reading `motionToTilt` takes, for browsers without gravity. */
export function orientationToMotion(beta: number, gamma: number): { x: number; y: number; z: number } {
  const r = Math.PI / 180;
  return { x: -Math.sin(gamma * r) * G, y: Math.sin(beta * r) * G, z: Math.cos(beta * r) * Math.cos(gamma * r) * G };
}

const dead = (v: number) => (Math.abs(v) < DEADZONE ? 0 : (Math.sign(v) * (Math.abs(v) - DEADZONE)) / (1 - DEADZONE));

/** A gamepad's right stick (axes 2, 3; down is +) to tilt: full throw is 1 g, pushing up tilts the top down. */
export function stickToTilt(ax: number, ay: number): Tilt {
  return { x: dead(ax), y: -dead(ay) || 0 };
}

/** I/J/K/L held: each axis ramps towards ±0.6 g (and back to 0 on release) over 250 ms. */
export function keysToTilt(held: Set<string>, prev: Tilt, dtMs: number): Tilt {
  const step = (KEY_G / KEY_RAMP_MS) * dtMs;
  const toward = (v: number, target: number) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));
  const axis = (plus: string, minus: string) => (held.has(plus) ? KEY_G : 0) - (held.has(minus) ? KEY_G : 0);
  return { x: toward(prev.x, axis('l', 'j')), y: toward(prev.y, axis('i', 'k')) };
}

/** Motion while the sensor delivers, else a connected pad, else the keyboard. */
export function pickSource(s: { motion: boolean; pad: boolean }): TiltSource {
  return s.motion ? 'motion' : s.pad ? 'pad' : 'keys';
}

/** Scales by the sensitivity setting (percent) and clamps to what the core takes. */
export function applySensitivity(t: Tilt, pct: number): Tilt {
  const c = (v: number) => Math.max(-MAX_G, Math.min(MAX_G, (v * pct) / 100));
  return { x: c(t.x), y: c(t.y) };
}
