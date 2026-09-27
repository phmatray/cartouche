import { Link } from 'react-router';
import { formatFilter, gameTags, type Key } from '../../lib/search';
import { paths, searchState } from '../../lib/ui';
import type { GameEntry } from '../../types/game';
import { useT } from '../../i18n';

/** Links that open the search with one of the game's facts as a filter. */
export function TagLinks({ game, keys = ['developer', 'year', 'genre'], className }: { game: GameEntry; keys?: Key[]; className?: string }) {
  const t = useT();
  const tags = gameTags(game).filter((x) => keys.includes(x.key)).sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
  if (!tags.length) return null;
  const links = tags.map((x) => (
    <Link key={x.label} className={className} to={paths.search(formatFilter(x.filter))} state={searchState()} title={t('library.searchTag', { tag: x.label })}>{x.label}</Link>
  ));
  return className ? <>{links}</> : <small className="tl">{links.flatMap((l, i) => (i ? [' · ', l] : [l]))}</small>;
}
