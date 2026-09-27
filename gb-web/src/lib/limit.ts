/** Runs the tasks given to it at most `n` at a time, the rest waiting in order. */
export function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T,>(run: () => Promise<T>): Promise<T> => {
    if (active < n) active++;
    else await new Promise<void>((go) => waiting.push(go)); // a finishing task hands its slot over
    try { return await run(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}
