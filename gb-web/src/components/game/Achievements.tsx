import { useEffect, useState } from 'react';
import type { GameEntry } from '../../types/game';
import { fetchRom } from '../../hooks/useGameLibrary';
import { BADGES, gameIdOf, getCreds, progressOf, RaError, romHash, type RaFail, type RaGame } from '../../lib/retroachievements';
import { getPlay } from '../../lib/ra-client';
import { date, useT } from '../../i18n';

type State = RaGame | null | RaFail;
/** One lookup per account, game and session: the game page and the manual share it. */
const seen = new Map<string, Promise<State>>();
function load(game: GameEntry): Promise<State> {
  const c = getCreds();
  if (!c) return Promise.resolve(null);
  const k = `${c.user}|${c.key}|${game.id}`;
  let p = seen.get(k);
  if (!p) {
    p = fetchRom(game).then(async (rom) => {
      const id = await gameIdOf(await romHash(rom), c);
      return id === null ? null : progressOf(id, c);
    }).catch((e) => (e instanceof RaError ? e.kind : 'net'));
    p.then((s) => { if (s === 'net') seen.delete(k); }); // offline: try again next time
    seen.set(k, p);
  }
  return p;
}

/** RetroAchievements' "2022-08-23 22:56:38" (UTC). */
const utc = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);

/** The player's RetroAchievements for this cartridge (read-only), for the game page and the manual. */
export default function Achievements({ game }: { game: GameEntry }) {
  const t = useT();
  const [s, setS] = useState<State | undefined>();
  useEffect(() => {
    let cancelled = false;
    load(game).then((r) => { if (!cancelled) setS(r); });
    return () => { cancelled = true; };
  }, [game]);
  const head = <h3>{t('ra.title')}</h3>;
  if (s === undefined) return <>{head}<div className="empty-inline" aria-busy="true"><span>{t('ra.looking')}</span></div></>;
  if (s === null || typeof s === 'string') {
    return <>{head}<div className="empty-inline"><span>{s === 'auth' ? t('ra.refused') : s === 'net' ? t('ra.offline') : t('ra.none')}</span></div></>;
  }
  const list = s.achievements, got = list.filter((a) => a.earned);
  const pts = (l: typeof list) => l.reduce((n, a) => n + a.points, 0);
  return (
    <>
      {head}
      <p className="ra-sum">
        <b>{t('ra.earned', { count: got.length, total: list.length })}</b>
        <span>{t('ra.points', { count: pts(got), total: pts(list) })}</span>
      </p>
      <ul className="ra-list">
        {list.map((a) => (
          <li key={a.id} className={a.earned ? 'got' : undefined}>
            <img src={`${BADGES}${a.badge}${a.earned ? '' : '_lock'}.png`} alt="" width={48} height={48} loading="lazy" />
            <span className="w">
              <b>{a.title}</b>
              <small>{a.description}</small>
              <small className="when">
                {a.earned ? t('ra.on', { date: date(utc(a.earned), { day: 'numeric', month: 'short', year: 'numeric' }) }) : t('ra.locked')}
                {a.earnedHardcore && <span className="tag now">{t('ra.hardcore')}</span>}
              </small>
            </span>
            <span className="pt">{a.points}<span className="sr"> {t('ra.pts', { count: a.points })}</span></span>
          </li>
        ))}
      </ul>
      <p className="note ra-foot">
        {!getPlay() && <>{t('ra.readOnly')} </>}<a href={`https://retroachievements.org/game/${s.id}`} target="_blank" rel="noreferrer">{t('ra.site')}</a>
      </p>
    </>
  );
}
