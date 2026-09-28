/** The Game Boy's real frame rate: 59.73 Hz. */
export const GB_FPS = 4194304 / 70224;

/**
 * Real-time pacing, whatever the display rate (120 Hz screens, 30 Hz in iPhone Low Power Mode): called once per
 * animation frame with the time in ms, it returns how many Game Boy frames are due. At most `max` per call, and a
 * stall (a hidden tab, a slow frame) is dropped rather than caught up.
 */
export function pacer(max = 4) {
  let last = -1, acc = 0, n = 0;
  return (now: number) => {
    acc += (last >= 0 ? Math.min(0.1, (now - last) / 1000) : 1 / GB_FPS) * GB_FPS;
    last = now;
    [n, acc] = take(acc, max);
    return n;
  };
}

/**
 * The frames to run now out of `acc` frames due (at most `max`), and what stays due: at most one frame. Frames over
 * the cap are dropped, never owed: a device too slow for 4× would otherwise pile them up and pay them back later,
 * racing through the game at up to `max` frames per display refresh once back at 1×.
 */
export function take(acc: number, max: number): [n: number, acc: number] {
  const n = Math.min(max, Math.floor(acc));
  return [n, Math.min(1, acc - n)];
}
