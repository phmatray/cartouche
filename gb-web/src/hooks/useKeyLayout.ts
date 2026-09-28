import { useEffect, useState } from 'react';

export type LayoutMap = { get(code: string): string | undefined };
let asked: Promise<LayoutMap | null> | undefined;

/** The characters this keyboard types by physical key (Chromium only; elsewhere null, and labels read as US keys). */
export function useKeyLayout() {
  const [layout, setLayout] = useState<LayoutMap | null>(null);
  useEffect(() => {
    let on = true;
    asked ??= (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<LayoutMap> } }).keyboard?.getLayoutMap?.().catch(() => null) ?? Promise.resolve(null);
    asked.then((m) => { if (on) setLayout(m); });
    return () => { on = false; };
  }, []);
  return layout;
}
