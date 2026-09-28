import { useCallback, useEffect, useRef } from 'react';
import { EV, getPlay, play, type RaEvent, type RaSession } from '../lib/ra-client';
import { romHash } from '../lib/retroachievements';
import { toast } from '../components/shell/actions';
import { t } from '../i18n';

/**
 * RetroAchievements unlocking for the game in the player (lib/ra-client), when the player signed in for it in
 * Settings › Achievements: starts at the first power-on, starts over at each restart, forgets hit counts at each
 * state load or rewind step (`jumped`). `frame` goes after every emulated frame.
 */
export function useRaSession(power: number, rom: () => Uint8Array | null, peek: (addr: number) => number, title: string) {
  const session = useRef<RaSession | null>(null);
  const started = useRef(false);
  const alive = useRef(true);
  const args = useRef({ rom, peek, title });
  useEffect(() => { args.current = { rom, peek, title }; });

  useEffect(() => {
    if (!power) return;
    if (started.current) { session.current?.reset(); return; }
    const data = args.current.rom();
    if (!data || !getPlay()) return;
    started.current = true;
    const events = (e: RaEvent) => {
      if (e.type === EV.UNLOCKED) toast(t('ra.unlocked', { title: e.title, count: e.points }), 'c', undefined, e.badge || undefined);
      // After the last unlock's own toast has had its moment (it comes in the same frame).
      else if (e.type === EV.COMPLETED) setTimeout(() => toast(t('ra.mastered', { title: args.current.title }), 'c'), 2500);
      else if (e.type === EV.SERVER_ERROR) toast(t('ra.serverError', { error: e.error }), 'm');
      else if (e.type === EV.DISCONNECTED) toast(t('ra.pending'), 'm');
      else if (e.type === EV.RECONNECTED) toast(t('ra.sent'), 'c');
    };
    romHash(data).then((h) => play(h, (a) => args.current.peek(a), events)).then((s) => {
      if (!alive.current) { s?.end(); return; }
      session.current = s;
      if (s) toast(t('ra.session', { count: s.earned, total: s.total }), '');
    }).catch(() => { /* RetroAchievements unreachable: the game plays on, without */ });
  }, [power]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; session.current?.end(); session.current = null; };
  }, []);

  const frame = useCallback(() => session.current?.frame(), []);
  const jumped = useCallback(() => session.current?.jumped(), []);
  return { frame, jumped };
}
