import { useEffect, useRef, useState } from 'react';
import { other, useNet } from '../../lib/netlink/session';
import { I } from '../icons';
import { toast } from '../shell/actions';
import { t as tNow, useT } from '../../i18n';
import './netlink.css';

// desync / inStep: lockstep mode (useLockstep): the two games no longer match / both consoles run in step here.
type Link = { on: boolean; waiting: number; gaveUp: number; unplug: () => void; bytes: () => number; waited: () => number; frames?: () => number; desync?: boolean; inStep?: boolean };
/** Stalls shorter than this (one round trip, most of the time) go unannounced: the picture just holds. */
const SHOW_AFTER_MS = 600;

/** Under the screen, while the cable is plugged in: who's on the other end and how the line is doing. */
export function LinkCap({ link }: { link: Link }) {
  const { phase, peer, ping, me, peerLeft, mode } = useNet();
  const t = useT();
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i); }, []); // the byte count
  const p = other(me.host);
  const text = phase === 'linked' ? (peer?.playing ? t('online.hud.linked', { p }) : t('online.hud.lobby', { p }))
    : phase === 'lost' ? t('online.hud.lost')
    : peerLeft ? t('online.hud.left', { p }) : phase === 'joining' ? t('online.hud.joining') : t('online.hud.waiting', { p });
  const n = link.bytes();
  // Only the state is announced (it changes rarely); the ping and the byte count tick on screen alone.
  return (
    <span data-waited={Math.round(link.waited())} data-mode={mode} data-frames={link.frames?.()} className={`nl-cap ${phase === 'linked' ? 'on' : phase === 'lost' ? 'lost' : ''}`}>
      {I.link}<b role="status">{text}</b>
      <span aria-hidden="true" className="nl-num">{phase === 'linked' && ping !== null && <span>{t('online.cable.ms', { ms: ping })}</span>}{n > 0 && <span>{t('online.hud.bytes', { count: n })}</span>}{mode === 'lockstep' && <span>{t('online.hud.inStep')}</span>}</span>
    </span>
  );
}

/** Over the screen when this console has waited a moment for the other one: why, and the way out. */
export function LinkWait({ link }: { link: Link }) {
  const { phase, peer, me, peerLeft } = useNet();
  const t = useT();
  const p = other(me.host);
  const first = useRef(link.gaveUp);
  useEffect(() => {
    if (link.gaveUp !== first.current) toast(tNow('online.wait.gaveUp', { p }), 'm');
  }, [link.gaveUp, p]);
  if (!link.on || (!link.desync && link.waiting < SHOW_AFTER_MS)) return null;
  const s = Math.floor(link.waiting / 1000);
  const [title, body] = link.desync ? [t('online.desync.title'), t('online.desync.body')]
    : phase === 'lost' ? [t('online.wait.lostT'), t('online.wait.lost', { p })]
    : peerLeft || phase !== 'linked' ? [t('online.wait.leftT', { p }), t('online.wait.left')]
    : peer?.paused ? [t('online.wait.pausedT', { p }), t('online.wait.paused')]
    : !peer?.playing ? [t('online.wait.notInT', { p }), t('online.wait.notIn')]
    : [t('online.wait.waitT', { p }), link.inStep ? t('online.wait.inStep', { p }) : t('online.wait.wait')];
  // Focus stays where it is: the overlay comes and goes with each slow byte, and Enter is the game's Start.
  return (
    <div className="overlay nl-wait">
      <span className="nl-plug" aria-hidden="true"><i /><i /><i /></span>
      <div role="alert"><b>{title}</b><p>{body}</p></div>
      <small aria-hidden="true">{s > 0 && !link.desync ? `${s} s` : ' '}</small>
      <button className="btn line" onClick={link.unplug}>{I.close}{t('online.wait.unplug')}</button>
    </div>
  );
}
