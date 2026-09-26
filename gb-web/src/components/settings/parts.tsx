import { useId, type ReactNode } from 'react';

/** One settings line with an on/off switch. */
export function SwitchRow({ label, sub, on, set }: { label: string; sub?: ReactNode; on: boolean; set: (v: boolean) => void }) {
  const id = useId();
  return (
    <Row label={label} sub={sub} subId={id}>
      <button className="switch" role="switch" aria-checked={on} aria-label={label} aria-describedby={sub ? id : undefined} onClick={() => set(!on)} />
    </Row>
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

export function Row({ label, sub, subId, children }: { label: string; sub?: ReactNode; subId?: string; children: ReactNode }) {
  return <div className="row"><span>{label}{sub && <small id={subId}>{sub}</small>}</span>{children}</div>;
}

/** A settings line with a slider and its value. */
export function Slider({ label, sub, value, min, max, set }: { label: string; sub?: ReactNode; value: number; min: number; max: number; set: (v: number) => void }) {
  const id = useId();
  const text = `${min < 0 && value > 0 ? '+' : ''}${value}%`;
  return (
    <Row label={label} sub={sub} subId={id}>
      <span className="range">
        <input type="range" min={min} max={max} value={value} aria-label={label} aria-valuetext={text} aria-describedby={sub ? id : undefined} onChange={(e) => set(+e.target.value)} />
        {/* Not an <output>: its live region would announce every step while dragging. */}
        <span className="v" aria-hidden="true">{text}</span>
      </span>
    </Row>
  );
}
