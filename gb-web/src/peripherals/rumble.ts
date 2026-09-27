// Rumble cartridges, felt through what the device has:
// - a gamepad with rumble motors (Gamepad API `vibrationActuator`, or the older `hapticActuators`);
// - a phone's vibration motor through the Vibration API (Android; iPhone Safari has no Vibration API);
// - on iPhone (iOS 18+), the tick Safari plays when a switch control toggles: a hidden
//   `<input type="checkbox" switch>` toggled from script. Safari only plays it inside a user gesture,
//   so while the motor runs each touch-button press ticks (`rumbleTouch`); the frame loop tries too,
//   in case a version plays it outside gestures;
// - optionally, a shake of the LCD frame (never with reduced motion).

type Actuator = { playEffect?: (t: string, p: object) => Promise<unknown>; reset?: () => Promise<unknown>; pulse?: (v: number, ms: number) => Promise<unknown> };
type Pad = Gamepad & { vibrationActuator?: Actuator | null; hapticActuators?: readonly Actuator[] };

export interface RumbleOpts { intensity: number; shake: boolean; frame?: HTMLElement | null }

const PULSE_MS = 120; // each effect outlasts the frame loop's re-issue interval
const REISSUE_MS = 80;
let running = false;
let last = 0;
let lastTick = 0;
let label: HTMLLabelElement | null = null;
const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

const pads = () => (navigator.getGamepads?.() ?? []).filter((p): p is Pad => !!p);
const padActuator = (p: Pad): Actuator | undefined => p.vibrationActuator ?? p.hapticActuators?.[0];

/** What this device can feel, for the settings page. */
export function rumbleOutputs(): { pad: boolean; vibrate: boolean; tick: boolean } {
  return {
    pad: pads().some((p) => !!padActuator(p)),
    vibrate: typeof navigator.vibrate === 'function',
    tick: typeof navigator.vibrate !== 'function' && 'ontouchstart' in window,
  };
}

/** Safari's switch tick. Returns false where no switch control exists. */
function tick() {
  if (!label) {
    label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.append(input);
    document.body.append(label);
  }
  label.click();
}

/** Drive the outputs with the motor's duty (0-1) over the last frames. Call once per animation frame. */
export function rumble(level: number, o: RumbleOpts) {
  const strength = Math.min(1, level * o.intensity / 100);
  const now = performance.now();
  if (strength <= 0.02) { if (running) stopRumble(o.frame); return; }
  running = true;
  if (o.shake && !reduced?.matches && o.frame) {
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
  if (felt) return;
  // A phone motor is on or off: the strength sets how much of each interval it runs.
  if (typeof navigator.vibrate === 'function') navigator.vibrate(Math.round(30 + 70 * strength));
  else if (now - lastTick > 160) { lastTick = now; tick(); }
}

export function stopRumble(frame?: HTMLElement | null) {
  if (frame) frame.style.translate = '';
  if (!running) return;
  running = false;
  for (const p of pads()) padActuator(p)?.reset?.().catch(() => {});
  if (typeof navigator.vibrate === 'function') navigator.vibrate(0);
}

/** A touch-button press while the motor runs: the iPhone switch tick (only allowed inside a gesture). */
export function rumbleTouch() {
  if (running && typeof navigator.vibrate !== 'function') tick();
}

/** "Test rumble" in Settings: half a second at `intensity`, from the click (a user gesture). */
export function testRumble(intensity: number) {
  const until = performance.now() + 500;
  const step = () => {
    if (performance.now() < until) { rumble(1, { intensity, shake: false }); requestAnimationFrame(step); }
    else stopRumble();
  };
  step();
}
