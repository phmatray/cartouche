import { Link } from 'react-router';
import { formatFilter, gameTags, type Key } from '../../lib/search';
import { paths, searchState } from '../../lib/ui';
import type { GameEntry } from '../../types/game';

/** Links that open the search with one of the game's facts as a filter. */
export function TagLinks({ game, keys = ['developer', 'year', 'genre'], className }: { game: GameEntry; keys?: Key[]; className?: string }) {
  const tags = gameTags(game).filter((t) => keys.includes(t.key)).sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
  if (!tags.length) return null;
  const links = tags.map((t) => (
    <Link key={t.label} className={className} to={paths.search(formatFilter(t.filter))} state={searchState()} title={`Search: ${t.label}`}>{t.label}</Link>
  ));
  return className ? <>{links}</> : <small className="tl">{links.flatMap((l, i) => (i ? [' · ', l] : [l]))}</small>;
}
