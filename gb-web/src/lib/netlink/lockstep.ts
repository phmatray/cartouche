/**
 * Input-delay lockstep (online link when both players hold both games): each browser runs both consoles, and only
 * the buttons cross the network. Our buttons for frame n go out as the input of frame n + delay; a frame runs once
 * both players' inputs for it are known, so both browsers run the same frames with the same buttons.
 */

/** Player `seat`'s buttons (8 bits, bit n = JoypadButton n) for frame `f`. */
export type LockMsg = { t: 'i'; f: number; b: number };

const frame = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
/** A well-formed input message from the other browser (anything else is dropped). */
export const isLockMsg = (m: { t?: unknown; f?: unknown; b?: unknown }): m is LockMsg =>
  m.t === 'i' && frame(m.f) && Number.isInteger(m.b) && (m.b as number) >= 0 && (m.b as number) <= 255;

/** The input delay in frames for a round trip: half of it in Game Boy frames, plus one, from 2 to 10. */
export const delayFor = (rttMs: number) => Math.min(10, Math.max(2, Math.ceil(rttMs / 2 / 16.74) + 1));

export class Lockstep {
  private own = new Map<number, number>();
  private theirs = new Map<number, number>();
  private floor = 0; // frames below this have run: their inputs are gone
  private seat: 1 | 2;
  private delay: number;

  /** Both players use the same delay; the first `delay` frames run with no button held. */
  constructor(seat: 1 | 2, delay: number) {
    this.seat = seat;
    this.delay = delay;
    for (let f = 0; f < delay; f++) { this.own.set(f, 0); this.theirs.set(f, 0); }
  }

  /** Our buttons, sampled before running `frame`: they apply at `frame + delay`. Returns the message to send. */
  local(frame: number, buttons: number): LockMsg {
    const m: LockMsg = { t: 'i', f: frame + this.delay, b: buttons & 0xff };
    this.own.set(m.f, m.b);
    return m;
  }

  /** The partner's input (a repeat or one for a frame already run is ignored). */
  remote(m: LockMsg) {
    if (m.f >= this.floor && !this.theirs.has(m.f)) this.theirs.set(m.f, m.b);
  }

  /** [player 1, player 2] buttons for `frame` once both are known, else null. */
  ready(frame: number): [number, number] | null {
    const a = this.own.get(frame), b = this.theirs.get(frame);
    if (a === undefined || b === undefined) return null;
    for (; this.floor < frame; this.floor++) { this.own.delete(this.floor); this.theirs.delete(this.floor); }
    return this.seat === 1 ? [a, b] : [b, a];
  }
}
