import type { ReactNode } from 'react';

/** One settings line with an on/off switch. */
export function SwitchRow({ label, sub, on, set }: { label: string; sub?: ReactNode; on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="row">
      <span>{label}{sub && <small>{sub}</small>}</span>
      <button className="switch" role="switch" aria-checked={on} aria-label={label} onClick={() => set(!on)} />
    </div>
  );
}

/** Segmented choice (Fit / 2× / 3×…). */
export function Seg<T extends string | number>({ label, value, options, set }: { label: string; value: T; options: [T, string][]; set: (v: T) => void }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => <button key={String(v)} aria-pressed={value === v} onClick={() => set(v)}>{l}</button>)}
    </div>
  );
}

export function Row({ label, sub, children }: { label: string; sub?: ReactNode; children: ReactNode }) {
  return <div className="row"><span>{label}{sub && <small>{sub}</small>}</span>{children}</div>;
}

/** A settings line with a slider and its value. */
export function Slider({ label, sub, value, min, max, set }: { label: string; sub?: ReactNode; value: number; min: number; max: number; set: (v: number) => void }) {
  return (
    <Row label={label} sub={sub}>
      <span className="range">
        <input type="range" min={min} max={max} value={value} aria-label={label} onChange={(e) => set(+e.target.value)} />
        <output>{min < 0 && value > 0 ? '+' : ''}{value}%</output>
      </span>
    </Row>
  );
}
