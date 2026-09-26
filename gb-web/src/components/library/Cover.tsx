import { useEffect, useRef, useState, type RefObject } from 'react';
import type { GameEntry } from '../../types/game';
import { useCoverArt } from '../../hooks/useCoverArt';

// One shared observer: a card asks for its box art only once it comes near the viewport
// (or scrolls into view inside a horizontal shelf).
const callbacks = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | null = null;
function watch(el: Element, onVisible: () => void) {
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      callbacks.get(e.target)?.();
      callbacks.delete(e.target);
      observer!.unobserve(e.target);
    }
  }, { rootMargin: '400px' });
  callbacks.set(el, onVisible);
  observer.observe(el);
  return () => { callbacks.delete(el); observer?.unobserve(el); };
}

function useSeen(ref: RefObject<Element | null>) {
  const [seen, setSeen] = useState(false);
  useEffect(() => (ref.current && !seen ? watch(ref.current, () => setSeen(true)) : undefined), [ref, seen]);
  return seen;
}

/**
 * A game title for the uppercase headings: CSS would turn the micro sign of "µCity" into a
 * capital Greek Mu ("MCITY"), so it keeps its case.
 */
export function Title({ text }: { text: string }) {
  if (!text.includes('µ')) return <Snake text={text} />;
  return <>{text.split('µ').map((part, i) => <span key={i}>{i > 0 && <span className="mu">µ</span>}<Snake text={part} /></span>)}</>;
}

/** Lets "cpu_instrs" wrap at the underscore rather than mid-word. */
function Snake({ text }: { text: string }) {
  return <>{text.split('_').map((part, i) => <span key={i}>{i > 0 && <><wbr />_</>}{part}</span>)}</>;
}

/** The printed card every box sits on: always there, so a missing or slow cover still looks designed. */
export function NoArt({ game }: { game: GameEntry }) {
  return (
    <div className="noart">
      <div><b data-long={game.title.length > 18 || undefined}><Title text={game.title} /></b></div>
      <div><small>{game.developer || (game.genre !== 'Unknown' ? game.genre : '')}</small><span className="bar"><i /><i /><i /></span></div>
    </div>
  );
}

/** Box art fading in over the printed card once (if) it arrives. */
export function Cover({ game, className = '' }: { game: GameEntry; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useSeen(ref);
  const { coverUrl, loading } = useCoverArt(game, seen);
  const [shown, setShown] = useState<string | null>(null);
  return (
    <span ref={ref} className={`cv ${className}${seen && loading ? ' wait' : ''}`}>
      <NoArt game={game} />
      {coverUrl && (
        <img src={coverUrl} alt="" width={512} height={512} decoding="async"
          className={shown === coverUrl ? 'in' : ''} onLoad={() => setShown(coverUrl)} />
      )}
    </span>
  );
}
