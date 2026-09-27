/**
 * The serial port of one Game Boy, carried to a partner in another browser (the core's remote link, see
 * gb-core/src/serial.rs). Lockstep at transfer granularity:
 *
 * - We clock a transfer (internal clock): the core stops at its start; we send `x` (our byte, its length).
 *   The partner answers `r` with the byte it shifted out; the core goes on and completes the transfer on its
 *   usual schedule. So the game sees the same timing whatever the latency: it only runs later.
 * - The partner clocks one (`x` arrives): the core takes it at once if the game is listening (external clock),
 *   holds it up to a frame otherwise, then answers (SB, or 0xFF when nobody listened); we send that as `r`.
 *
 * Every request has a sequence number, so after a reconnection a request can be sent again (`resend`) and a
 * repeated one is answered with the same byte instead of being clocked twice.
 */
export interface LinkCore {
  link_take_request(): number;
  link_take_reply(): number;
  link_remote_clock(byte: number, cycles: number): void;
  link_remote_reply(byte: number): void;
}

export type LinkMsg = { t: 'x'; s: number; b: number; c: number } | { t: 'r'; s: number; b: number };

const int = (v: unknown) => Number.isSafeInteger(v);
/** A well-formed cable message from the other browser (anything else is dropped). */
export const isLinkMsg = (m: { t?: unknown; s?: unknown; b?: unknown; c?: unknown }): m is LinkMsg =>
  (m.t === 'x' && int(m.s) && int(m.b) && int(m.c)) || (m.t === 'r' && int(m.s) && int(m.b));
/** The longest transfer a Game Boy clocks: 8 bits × 512 cycles. */
const MAX_CYCLES = 8 * 512;

export class SerialBridge {
  /** Bytes exchanged (either direction), for the link badge. */
  bytes = 0;
  /** Total ms our console spent waiting for answers. */
  waited = 0;
  /** When our pending transfer was sent (performance.now), 0 when none is waiting. */
  waitingSince = 0;
  private seq = Math.floor(Math.random() * 1e9); // a reloaded partner never reuses our old numbers
  private pending: { s: number; b: number; c: number } | null = null;
  private held = -1; // the partner request the core holds (its number)
  private answered = { s: -1, b: 0xff };
  private core: LinkCore;
  private send: (m: LinkMsg) => void;
  private now: () => number;

  constructor(core: LinkCore, send: (m: LinkMsg) => void, now = () => performance.now()) {
    this.core = core;
    this.send = send;
    this.now = now;
  }

  /** After every frame the core ran (and after each message): what the core has to say goes out. */
  pump() {
    const reply = this.core.link_take_reply();
    if (reply >= 0 && this.held >= 0) {
      this.answered = { s: this.held, b: reply };
      this.held = -1;
      this.bytes++;
      this.send({ t: 'r', s: this.answered.s, b: reply });
    }
    const req = this.core.link_take_request();
    if (req >= 0) {
      this.pending = { s: ++this.seq, b: req & 0xff, c: req >>> 8 };
      this.waitingSince = this.now();
      this.send({ t: 'x', ...this.pending });
    }
  }

  receive(m: LinkMsg) {
    if (m.t === 'x') {
      if (m.s === this.answered.s) this.send({ t: 'r', s: m.s, b: this.answered.b }); // our answer was lost
      else if (m.s !== this.held) {
        this.pump(); // an answer the core already has goes to the request it belongs to
        const old = this.held;
        this.held = m.s;
        this.core.link_remote_clock(m.b & 0xff, Math.min(Math.max(m.c, 1), MAX_CYCLES));
        // The core still held an older request: it just refused it (0xFF). Its sender gave up on it already.
        if (old >= 0) this.core.link_take_reply();
        this.pump();
      }
    } else if (this.pending && m.s === this.pending.s) {
      this.core.link_remote_reply(m.b & 0xff);
      this.waited += this.now() - this.waitingSince;
      this.pending = null;
      this.waitingSince = 0;
      this.bytes++;
    }
  }

  /** The partner (re)connected: our request may never have reached it. */
  resend() {
    if (this.pending) this.send({ t: 'x', ...this.pending });
  }

  /** Stop waiting: the transfer completes with 0xFF, as if the cable had been pulled. */
  giveUp() {
    if (!this.pending) return;
    this.core.link_remote_reply(0xff);
    this.pending = null;
    this.waitingSince = 0;
  }
}
