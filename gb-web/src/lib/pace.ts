/** The Game Boy's real frame rate: 59.73 Hz. */
export const GB_FPS = 4194304 / 70224;

/**
 * Real-time pacing, whatever the display rate (120 Hz screens, 30 Hz in iPhone Low Power Mode): called once per
 * animation frame with the time in ms, it returns how many Game Boy frames are due. At most `max` per call, and a
 * stall (a hidden tab, a slow frame) is dropped rather than caught up.
 */
export function pacer(max = 4) {
  let last = -1, acc = 0;
  return (now: number) => {
    acc += (last >= 0 ? Math.min(0.1, (now - last) / 1000) : 1 / GB_FPS) * GB_FPS;
    last = now;
    const n = Math.min(max, Math.floor(acc));
    acc = Math.min(1, acc - n);
    return n;
  };
}
