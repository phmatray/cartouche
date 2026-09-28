import { useEffect, useState } from 'react';
import type { GameEntry } from '../../types/game';
import { fetchRom } from '../../hooks/useGameLibrary';
import { BADGES, earnedNow, gameIdOf, getCreds, inPlayOrder, onUnlock, progressOf, RaError, romHash, type RaAchievement, type RaFail, type RaGame } from '../../lib/retroachievements';
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
// Achievement ids are unique across games: mark it in whichever cached game has it.
onUnlock((id) => seen.forEach((p, k) => seen.set(k, p.then((s) => (s && typeof s === 'object' ? earnedNow(s, id) : s)))));

/** RetroAchievements' "2022-08-23 22:56:38" (UTC). */
const utc = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);

/** The player's RetroAchievements for this cartridge (read-only), for the game page and the manual. */
export default function Achievements({ game }: { game: GameEntry }) {
  const t = useT();
  const [s, setS] = useState<State | undefined>();
  useEffect(() => {
    let cancelled = false;
    const show = () => load(game).then((r) => { if (!cancelled) setS(r); });
    show();
    const off = onUnlock(show); // registered after the cache's own listener, so it reads the updated list
    return () => { cancelled = true; off(); };
  }, [game]);
  const head = <h3>{t('ra.title')}</h3>;
  if (s === undefined) return <>{head}<div className="empty-inline" aria-busy="true"><span>{t('ra.looking')}</span></div></>;
  if (s === null || typeof s === 'string') {
    return <>{head}<div className="empty-inline"><span>{s === 'auth' ? t('ra.refused') : s === 'net' ? t('ra.offline') : t('ra.none')}</span></div></>;
  }
  const list = s.achievements, { next, earned } = inPlayOrder(list);
  const pts = (l: typeof list) => l.reduce((n, a) => n + a.points, 0);
  const row = (a: RaAchievement) => (
    <li key={a.id} className={a.earned ? 'got' : undefined}>
      <img src={`${BADGES}${a.badge}${a.earned ? '' : '_lock'}.png`} alt="" width={48} height={48} loading="lazy" />
      <span className="w">
        <b>{a.title}</b>
        <small>{a.description}</small>
        {(a.earned || a.missable) && (
          <small className="when">
            {a.earned && t('ra.on', { date: date(utc(a.earned), { day: 'numeric', month: 'short', year: 'numeric' }) })}
            {a.earnedHardcore && <span className="tag now">{t('ra.hardcore')}</span>}
            {!a.earned && a.missable && <span className="tag miss">{t('ra.missable')}</span>}
          </small>
        )}
      </span>
      <span className="pt">{a.points}<span className="sr"> {t('ra.pts', { count: a.points })}</span></span>
    </li>
  );
  return (
    <>
      {head}
      <p className="ra-sum">
        <b>{t('ra.earned', { count: earned.length, total: list.length })}</b>
        <span>{t('ra.points', { count: pts(earned), total: pts(list) })}</span>
      </p>
      <span className="ra-bar" role="progressbar" aria-label={t('ra.title')} aria-valuemin={0} aria-valuemax={list.length} aria-valuenow={earned.length}>
        <i style={{ transform: `scaleX(${list.length ? earned.length / list.length : 0})` }} />
      </span>
      {/* What is left first (the set's order), then what is earned, latest first. */}
      {next.length > 0 && <><h4 className="ra-h">{t('ra.next', { count: next.length })}</h4><ul className="ra-list">{next.map(row)}</ul></>}
      {earned.length > 0 && <><h4 className="ra-h">{t('ra.done', { count: earned.length })}</h4><ul className="ra-list">{earned.map(row)}</ul></>}
      <p className="note ra-foot">
        {!getPlay() && <>{t('ra.readOnly')} </>}<a href={`https://retroachievements.org/game/${s.id}`} target="_blank" rel="noreferrer">{t('ra.site')}</a>
      </p>
    </>
  );
}
