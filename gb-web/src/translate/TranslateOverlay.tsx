import { useState, type CSSProperties } from 'react';
import { useTranslate, type LiveBox } from './store';
import './translate.css';

const BY: Record<string, string> = { chrome: 'Chrome', claude: 'Claude', cache: 'Saved' };

/**
 * Translation slips over the game's text boxes: printed paper pinned where the text is, in Game Boy pixel
 * coordinates (the parent is the screen's frame). A slip in the lower half grows upward, so a long
 * translation never runs off the bottom. Tap one to see the original as read; tap again for the translation.
 */
export function TranslateOverlay({ gameId }: { gameId: string }) {
  const on = useTranslate((s) => !!s.games[gameId]);
  const boxes = useTranslate((s) => s.boxes);
  if (!on) return null;
  return (
    <div className="tl" aria-live="polite">
      {boxes.map((b) => <Slip key={`${b.x},${b.y},${b.source}`} b={b} />)}
    </div>
  );
}

function Slip({ b }: { b: LiveBox }) {
  const lang = useTranslate((s) => s.lang);
  const [original, setOriginal] = useState(false);
  const low = b.y + b.h / 2 > 72;
  const pad = 3;
  // At least 104 px wide (a two-character name translates to a word or three), from where the text starts,
  // moved left only as far as the screen's edge needs.
  const w = Math.min(160, Math.max(104, b.w + 2 * pad));
  const x0 = Math.max(0, Math.min(160 - w, b.x - pad)), x1 = x0 + w;
  const style: CSSProperties = {
    left: `${(x0 / 160) * 100}%`, width: `${((x1 - x0) / 160) * 100}%`,
    minHeight: `${((b.h + 2 * pad) / 144) * 100}%`,
    ...(low ? { bottom: `${((144 - Math.min(144, b.y + b.h + pad)) / 144) * 100}%` } : { top: `${(Math.max(0, b.y - pad) / 144) * 100}%` }),
  };
  const done = b.state === 'done' && !!b.translation;
  const showOriginal = !done || original;
  const text = showOriginal ? b.source : b.translation!;
  const label = done
    ? original ? `${b.sourceLang.toUpperCase()} · as read` : `${lang.toUpperCase()} · ${BY[b.by ?? ''] ?? ''}`
    : b.state === 'translating' ? `${lang.toUpperCase()} · translating` : b.state === 'raw' ? `${b.sourceLang.toUpperCase()} · as read` : 'Not translated';
  return (
    <button type="button" className={`slip ${b.state}${low ? ' low' : ''}${text.length > 90 ? ' long' : ''}`} style={style}
      lang={showOriginal ? b.sourceLang : lang} disabled={!done}
      onClick={() => setOriginal((v) => !v)}
      aria-label={done ? `${text}. ${original ? 'Show the translation' : 'Show the original'}` : text}>
      <span className="tab">{label}</span>
      <span className="txt">{text}</span>
      {b.state === 'error' && <span className="err">{b.error}</span>}
      {b.note && <span className="note">{b.note}</span>}
      {b.state === 'translating' && <span className="bar" aria-hidden="true" />}
    </button>
  );
}

/** The deck's translate mark: a speech slip with a letter on it, in the icon set's stroke. */
export const TranslateMark = () => (
  <svg className="icon tl-mark" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 4h18v12h-8l-5 4v-4H3z" fill="none" stroke="currentColor" strokeWidth="2.2" />
    <path d="m8.5 13 3.5-6.5 3.5 6.5M9.8 10.8h4.4" fill="none" stroke="currentColor" strokeWidth="2" />
  </svg>
);
