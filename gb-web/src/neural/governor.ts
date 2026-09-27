/**
 * Automatic quality fallback for the neural upscaler, fed the cost of the neural passes alone (never the
 * display cadence, so a 30 Hz screen or Low Power Mode does not count against it): GPU time from
 * EXT_disjoint_timer_query_webgl2, or without it a synchronised wall-clock sample every few frames. When the
 * median of the last `window` samples is over budget it steps down one level: the tile network plus the
 * table, then the table alone, then no neural upscaling. After `retry` samples at a lower level with the
 * median within budget it tries one level up again; every step down doubles that wait, so a device that
 * cannot keep up settles instead of flapping.
 */
export type NeuralLevel = 2 | 1 | 0;
export const LEVEL_NAMES: Record<NeuralLevel, string> = { 2: 'tile network + table', 1: 'table only', 0: 'off' };

export class Governor {
  level: NeuralLevel;
  private top: NeuralLevel;
  private samples: number[] = [];
  private budgetMs: number;
  private window: number;
  private retry: number;
  private calm = 0;

  /**
   * `budgetMs`: most time the neural passes may take per frame (half a 60 Hz frame: some drivers, ANGLE on
   * Metal among them, report timer queries several times higher than the real cost).
   */
  constructor(top: NeuralLevel, budgetMs = 8, window = 60, retry = window * 10) {
    this.level = this.top = top;
    this.budgetMs = budgetMs;
    this.window = window;
    this.retry = retry;
  }

  /** A timing of the neural passes, in ms. Returns true when the level changed. */
  sample(ms: number): boolean {
    this.samples.push(ms);
    if (this.samples.length > this.window) this.samples.shift();
    if (this.samples.length < this.window) return false;
    const sorted = [...this.samples].sort((a, b) => a - b);
    if (sorted[sorted.length >> 1] > this.budgetMs && this.level > 0) return this.step(-1);
    if (this.level < this.top && ++this.calm >= this.retry) return this.step(1);
    return false;
  }

  /** A frame at level 0 (nothing to time): only counts towards the next try. */
  idle(): boolean { return this.sample(0); }

  private step(d: 1 | -1): boolean {
    this.level = (this.level + d) as NeuralLevel;
    if (d < 0) this.retry *= 2;
    this.samples = [];
    this.calm = 0;
    return true;
  }
}

/**
 * The level the player's upscaler dropped to, for the AI note (null: running as chosen). Set by the engine
 * whose governor changed level, cleared when that engine goes away.
 */
let shown: NeuralLevel | null = null, owner: object | null = null;
const subs = new Set<() => void>();
export const neuralStatus = {
  get: (): NeuralLevel | null => shown,
  subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; },
  set(from: object, level: NeuralLevel | null): void { owner = from; shown = level; subs.forEach((f) => f()); },
  clear(from: object): void { if (owner === from) this.set(from, null); },
};
