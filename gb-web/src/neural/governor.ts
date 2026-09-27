/**
 * Automatic quality fallback for the neural upscaler. It is fed either the GPU time of the neural passes
 * (EXT_disjoint_timer_query_webgl2) or, without timer queries, the time between drawn frames. When the
 * median of the last `window` samples is over budget, it steps down one level: the tile network plus the
 * table, then the table alone, then no neural upscaling. It never steps back up by itself: a changed
 * setting (a new engine or filter change) starts over at the top.
 */
export type NeuralLevel = 2 | 1 | 0;
export const LEVEL_NAMES: Record<NeuralLevel, string> = { 2: 'tile network + table', 1: 'table only', 0: 'off' };

export class Governor {
  level: NeuralLevel;
  private samples: number[] = [];
  private gpuBudgetMs: number;
  private frameBudgetMs: number;
  private window: number;

  /**
   * `gpuBudgetMs`: most GPU time the neural passes may take per frame (half a 60 Hz frame: some drivers, ANGLE on
   * Metal among them, report timer queries several times higher than the real cost). `frameBudgetMs`: longest median time
   * between frames (only used without GPU timing; gaps over 100 ms, a pause or a still preview, are ignored).
   */
  constructor(top: NeuralLevel, gpuBudgetMs = 8, frameBudgetMs = 1000 / 40, window = 60) {
    this.level = top;
    this.gpuBudgetMs = gpuBudgetMs;
    this.frameBudgetMs = frameBudgetMs;
    this.window = window;
  }

  /** A GPU timing of the neural passes, in ms. Returns true when the level just dropped. */
  gpu(ms: number): boolean { return this.push(ms, this.gpuBudgetMs); }

  /** Time since the previous drawn frame, in ms (when there is no GPU timer). */
  frame(ms: number): boolean { return ms > 100 ? false : this.push(ms, this.frameBudgetMs); }

  private push(v: number, budget: number): boolean {
    if (this.level === 0) return false;
    this.samples.push(v);
    if (this.samples.length < this.window) return false;
    if (this.samples.length > this.window) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    if (sorted[sorted.length >> 1] <= budget) return false;
    this.level = (this.level - 1) as NeuralLevel;
    this.samples = [];
    return true;
  }
}
