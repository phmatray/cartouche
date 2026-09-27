import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useT } from '../i18n';
import { useTranslate, type LiveBox } from './store';
import { liveSession } from './useLiveTranslate';
import './translate.css';

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

/**
 * Live translate over the screen, in Game Boy pixel coordinates (the parent is the screen's frame). A finished
 * translation is a printed slip pinned over the game's text box; tap it for the original, hold it to see the
 * game underneath. Anything else (translating, the text as read, an error) is only a small tab on the box's
 * corner: the game's own text stays readable. Screen readers hear finished translations only.
 */
export function TranslateOverlay({ gameId }: { gameId: string }) {
  const t = useT();
  const on = useTranslate((s) => !!s.games[gameId]);
  const boxes = useTranslate((s) => s.boxes);
  const [hidden, setHidden] = useState<{ x: number; y: number; before: Record<string, string | undefined> } | null>(null);
  useEffect(() => {
    if (!hidden) return;
    const id = setTimeout(() => setHidden(null), 5000);
    return () => clearTimeout(id);
  }, [hidden]);
  if (!on) return null;
  const notText = (b: LiveBox) => {
    const before = liveSession()?.notText(b.keys);
    if (before) setHidden({ x: b.x, y: b.y, before });
  };
  const done = boxes.filter((b) => b.state === 'done' && b.translation);
  return (
    <div className="tl">
      {boxes.map((b) => (b.state === 'done' && b.translation
        ? <Slip key={`${b.x},${b.y},${b.source}`} b={b} onNotText={() => notText(b)} />
        : <Tag key={`${b.x},${b.y},${b.source}`} b={b} onNotText={() => notText(b)} />))}
      {hidden && (
        <span className="tl-tag hid" style={{ left: pct(hidden.x, 160), top: pct(hidden.y, 144) }}>
          <span>{t('translate.slip.hidden')}</span>
          <button type="button" onClick={() => { liveSession()?.restore(hidden.before); setHidden(null); }}>{t('translate.slip.undo')}</button>
        </span>
      )}
      <div className="sr" aria-live="polite">{done.map((b) => b.translation).join('\n')}</div>
    </div>
  );
}

/** The ✕ on a tab: this isn't text (a status bar, a logo), stop reading it in this game. */
function NotText({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" className="nt" onClick={(e) => { e.stopPropagation(); onClick(); }} aria-label={t('translate.slip.notTextLabel')} title={t('translate.slip.notText')}>
      <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.8" /></svg>
    </button>
  );
}

/** A box not translated (yet): a tab on its top-left corner saying why, over the game's own text. */
function Tag({ b, onNotText }: { b: LiveBox; onNotText: () => void }) {
  const t = useT();
  const lang = useTranslate((s) => s.lang);
  const label = b.state === 'translating' ? t('translate.slip.translating', { lang: lang.toUpperCase() })
    : b.state === 'raw' ? b.note ?? t('translate.slip.asRead', { lang: b.sourceLang.toUpperCase() })
      : b.error ?? t('translate.slip.notTranslated');
  return (
    // Above the text; under it when the box starts at the top of the screen.
    <span className={`tl-tag ${b.state}${b.y < 12 ? ' under' : ''}`} style={{ left: pct(b.x, 160), top: pct(b.y < 12 ? b.y + b.h : b.y, 144) }} title={b.state === 'raw' ? b.source : undefined}>
      <span aria-hidden="true">{label}</span>
      {b.state !== 'translating' && <NotText onClick={onNotText} />}
    </span>
  );
}

function Slip({ b, onNotText }: { b: LiveBox; onNotText: () => void }) {
  const t = useT();
  const lang = useTranslate((s) => s.lang);
  const [original, setOriginal] = useState(false);
  const [peek, setPeek] = useState(false);
  const hold = useRef<{ timer: number; peeked: boolean }>({ timer: 0, peeked: false });
  const low = b.y + b.h / 2 > 72;
  const pad = 3;
  // At least 104 px wide (a two-character name translates to a word or three), from where the text starts,
  // moved left only as far as the screen's edge needs.
  const w = Math.min(160, Math.max(104, b.w + 2 * pad));
  const x0 = Math.max(0, Math.min(160 - w, b.x - pad)), x1 = x0 + w;
  const style: CSSProperties = {
    left: pct(x0, 160), width: pct(x1 - x0, 160),
    minHeight: pct(b.h + 2 * pad, 144),
    ...(low ? { bottom: pct(144 - Math.min(144, b.y + b.h + pad), 144) } : { top: pct(Math.max(0, b.y - pad), 144) }),
  };
  const text = original ? b.source : b.translation!;
  const label = original ? t('translate.slip.asRead', { lang: b.sourceLang.toUpperCase() })
    : t('translate.slip.translated', { lang: lang.toUpperCase(), by: b.by ? t(`translate.slip.by.${b.by}`) : '' });
  // Hold: the slip fades to show the game under it, back on release (a tap still flips it).
  const down = () => { hold.current.peeked = false; hold.current.timer = window.setTimeout(() => { hold.current.peeked = true; setPeek(true); }, 280); };
  const up = () => { clearTimeout(hold.current.timer); setPeek(false); };
  return (
    <div className={`slip${low ? ' low' : ''}${peek ? ' peek' : ''}${text.length > 90 ? ' long' : ''}`} style={style}>
      <button type="button" className="face" lang={original ? b.sourceLang : lang}
        onPointerDown={down} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} onContextMenu={(e) => e.preventDefault()}
        onClick={() => { if (hold.current.peeked) { hold.current.peeked = false; return; } setOriginal((v) => !v); }}
        aria-label={t(original ? 'translate.slip.showTranslation' : 'translate.slip.showOriginal', { text })}>
        <span className="txt">{text}</span>
      </button>
      <span className="tab"><span aria-hidden="true">{label}</span><NotText onClick={onNotText} /></span>
    </div>
  );
}

/** The deck's translate mark: a speech slip with a letter on it, in the icon set's stroke. */
export const TranslateMark = () => (
  <svg className="icon tl-mark" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 4h18v12h-8l-5 4v-4H3z" fill="none" stroke="currentColor" strokeWidth="2.2" />
    <path d="m8.5 13 3.5-6.5 3.5 6.5M9.8 10.8h4.4" fill="none" stroke="currentColor" strokeWidth="2" />
  </svg>
);
