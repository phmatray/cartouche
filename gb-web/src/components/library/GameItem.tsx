import { Link } from 'react-router';
import type { GameEntry } from '../../types/game';
import { ago, byline, dur, letterOf, paths, tagOf } from '../../lib/ui';
import { I } from '../icons';
import { Cover, Title } from './Cover';

/** A box on the shelf: cover, title, byline, play time and ROM status. */
export function Item({ game, saved }: { game: GameEntry; saved: Set<string> }) {
  const [kind, label] = tagOf(game, saved);
  const sub = byline(game);
  return (
    <Link className="item" to={paths.game(game.id)} data-letter={letterOf(game)}>
      <div className="art">
        <Cover game={game} />
        {game.isFavorite && <span className="fav" title="Favorite">{I.starS}</span>}
      </div>
      <h3><Title text={game.title} /></h3>
      <div className="sub">{sub || '\u00a0'}</div>
      {game.hint && <div className="hint">{game.hint}</div>}
      {!!game.totalPlayTime && <div className="time">{dur(game.totalPlayTime)} played</div>}
      <span className={`tag ${kind}`}>{label}</span>
    </Link>
  );
}

export function ListRow({ game, saved, onFavorite }: { game: GameEntry; saved: Set<string>; onFavorite: (id: string) => void }) {
  const [kind, label] = tagOf(game, saved);
  const small = [byline(game), game.genre !== 'Unknown' ? game.genre : ''].filter(Boolean).join(' · ');
  return (
    <div className="lrow" data-letter={letterOf(game)}>
      <Link to={paths.game(game.id)} tabIndex={-1} aria-hidden="true"><Cover game={game} /></Link>
      <Link className="t" to={paths.game(game.id)} style={{ textDecoration: 'none' }}><Title text={game.title} />{small && <small>{small}</small>}</Link>
      <span className="c">{dur(game.totalPlayTime)}</span>
      <span className="c">{game.lastPlayed ? ago(game.lastPlayed) : 'Never'}</span>
      <span className={`tag ${kind}`}>{label}</span>
      <button className="star" aria-pressed={!!game.isFavorite} aria-label={`Favorite ${game.title}`} onClick={() => onFavorite(game.id)}>
        {game.isFavorite ? I.star : I.starO}
      </button>
    </div>
  );
}
