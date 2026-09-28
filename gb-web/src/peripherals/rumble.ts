// Rumble cartridges, felt through what the device has:
// - a gamepad with rumble motors (Gamepad API `vibrationActuator`, or the older `hapticActuators`);
// - a phone's vibration motor through the Vibration API (Android; iPhone Safari has none);
// - on iPhone, the tick Safari plays when a switch control toggles. Safari only plays it for a real tap
//   on the switch or its label (a scripted click is untrusted, and so is the click a label forwards
//   for it), so each touch button carries a transparent label over a hidden switch, enabled only while
//   the motor runs: a tap on a button while the motor runs ticks on release. Unverified on a real phone;
//   the settings page says so plainly;
// - optionally, a shake of the LCD frame (never with reduced motion).

import './peripherals.css';
import { reducedMotion } from '../lib/ui';

type Actuator = { playEffect?: (t: string, p: object) => Promise<unknown>; reset?: () => Promise<unknown>; pulse?: (v: number, ms: number) => Promise<unknown> };
type Pad = Gamepad & { vibrationActuator?: Actuator | null; hapticActuators?: readonly Actuator[] };

export interface RumbleOpts { intensity: number; shake: boolean; frame?: HTMLElement | null }

const PULSE_MS = 120; // each effect outlasts the frame loop's re-issue interval
const REISSUE_MS = 80;
let running = false;
let last = 0;

const pads = () => (navigator.getGamepads?.() ?? []).filter((p): p is Pad => !!p);
const padActuator = (p: Pad): Actuator | undefined => p.vibrationActuator ?? p.hapticActuators?.[0];
/** No Vibration API, a touch screen and switch controls: iPhone Safari. */
const tickOnly = () => typeof navigator.vibrate !== 'function' && 'ontouchstart' in window && 'switch' in HTMLInputElement.prototype;

/** What this device can feel, for the settings page. */
export function rumbleOutputs(): { pad: boolean; vibrate: boolean; tick: boolean } {
  return { pad: pads().some((p) => !!padActuator(p)), vibrate: typeof navigator.vibrate === 'function', tick: tickOnly() };
}

const armTicks = (on: boolean) => document.querySelectorAll<HTMLInputElement>('.rtick input').forEach((i) => { i.disabled = !on; });

/** Put a tick label over every touch button (iPhone only); returns the cleanup. */
export function mountTicks(): () => void {
  if (!tickOnly()) return () => {};
  const labels = [...document.querySelectorAll<HTMLElement>('.touch [data-pad]')].map((b) => {
    const label = document.createElement('label');
    label.className = 'rtick';
    label.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    input.disabled = !running;
    label.append(input);
    b.append(label);
    return label;
  });
  return () => labels.forEach((l) => l.remove());
}

/** Drive the outputs with the motor's duty (0-1) over the last frames. Call once per animation frame. */
export function rumble(level: number, o: RumbleOpts) {
  const strength = Math.min(1, level * o.intensity / 100);
  const now = performance.now();
  if (strength <= 0.02) { if (running) stopRumble(o.frame); return; }
  if (!running) { running = true; armTicks(true); }
  if (o.shake && !reducedMotion() && o.frame) {
    const a = 1 + 2 * strength;
    o.frame.style.translate = `${((Math.random() * 2 - 1) * a).toFixed(1)}px ${((Math.random() * 2 - 1) * a).toFixed(1)}px`;
  }
  if (now - last < REISSUE_MS) return;
  last = now;
  let felt = false;
  for (const p of pads()) {
    const act = padActuator(p);
    if (act?.playEffect) act.playEffect('dual-rumble', { startDelay: 0, duration: PULSE_MS, strongMagnitude: strength, weakMagnitude: strength * 0.6 }).catch(() => {});
    else if (act?.pulse) act.pulse(strength, PULSE_MS).catch(() => {});
    felt ||= !!act;
  }
  // A phone motor is on or off: the strength sets how much of each interval it runs.
  if (!felt && typeof navigator.vibrate === 'function') navigator.vibrate(Math.round(30 + 70 * strength));
}

export function stopRumble(frame?: HTMLElement | null) {
  if (frame) frame.style.translate = '';
  if (!running) return;
  running = false;
  armTicks(false);
  for (const p of pads()) padActuator(p)?.reset?.().catch(() => {});
  if (typeof navigator.vibrate === 'function') navigator.vibrate(0);
}

/** "Test rumble" in Settings: half a second at `intensity`. */
export function testRumble(intensity: number) {
  const until = performance.now() + 500;
  const step = () => {
    if (performance.now() < until) { rumble(1, { intensity, shake: false }); requestAnimationFrame(step); }
    else stopRumble();
  };
  step();
}
