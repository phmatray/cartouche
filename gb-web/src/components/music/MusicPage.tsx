import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAnimationFrame } from '../../hooks/useAnimationFrame';
import { useAudio } from '../../hooks/useAudio';
import { useEmulator } from '../../hooks/useEmulator';
import { useMusicLibrary } from '../../hooks/useMusicLibrary';
import { deleteMusic, getMusic, type StoredMusic } from '../../lib/db';
import { pacer } from '../../lib/pace';
import { useT } from '../../i18n';
import { I } from '../icons';
import { ConfirmDialog, type ConfirmRequest } from '../shell/ConfirmDialog';

/** A GBS music file: its tracks, played on the emulator (each track on a fresh console, gb-core/src/gbs.rs). */
export function MusicPage() {
  const { id = '' } = useParams();
  const t = useT();
  const navigate = useNavigate();
  const { reload } = useMusicLibrary();
  const [music, setMusic] = useState<StoredMusic | null>();
  const [track, setTrack] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const { isReady, loadGbs, runFrame, getAudioSamples, errors } = useEmulator();
  const { ensureStarted, feedSamples } = useAudio(playing);
  const pace = useRef(pacer());

  useEffect(() => {
    getMusic(id).then((m) => {
      setMusic(m ?? null);
      if (m) setTrack(Math.min(m.songs - 1, Math.max(0, m.first - 1)));
    }, () => setMusic(null));
  }, [id]);
  useEffect(() => { document.title = t('common.docTitle', { page: music?.title || t('library.music.shelf') }); }, [music, t]);

  // Every track starts on a clean machine, as GBS players do.
  useEffect(() => {
    if (isReady && music) loadGbs(music.data, track);
  }, [isReady, music, track, loadGbs]);

  useAnimationFrame(() => {
    for (let n = pace.current(performance.now()); n > 0; n--) {
      runFrame();
      const s = getAudioSamples();
      if (s) feedSamples(s);
    }
  }, playing && isReady && !!music);

  if (music === undefined) return <main className="wrap loading" aria-busy="true" />;
  if (music === null) return <main className="wrap"><div className="pagehead"><p>{t('player.music.missing')}</p><Link className="btn line" to="/">{t('shell.nav.library')}</Link></div></main>;

  const toggle = () => {
    if (!playing) {
      pace.current = pacer();
      void ensureStarted(true); // inside the gesture, as iOS requires
    }
    setPlaying(!playing);
  };
  const step = (d: number) => setTrack((k) => (k + d + music.songs) % music.songs);
  const remove = () => setConfirm({
    title: t('player.music.deleteTitle', { title: music.title }), body: t('player.music.deleteBody'), ok: t('player.music.delete'), danger: true,
    run: async () => { setPlaying(false); await deleteMusic(music.id); await reload(); navigate('/'); },
  });

  return (
    <main className="wrap">
      <div className="pagehead">
        <h1>{music.title}</h1>
        <p>{[music.author, music.copyright].filter(Boolean).join(' · ')}</p>
        {errors.length > 0 && <p role="alert">{t('player.music.bad')}</p>}
        <div className="acts" style={{ marginTop: 20 }}>
          <button className="btn line" onClick={() => step(-1)} aria-label={t('player.music.prev')}>{I.left}</button>
          <button className="btn y" onClick={toggle}>{playing ? I.pause : I.play}{t(playing ? 'player.music.pause' : 'player.music.play')}</button>
          <button className="btn line" onClick={() => step(1)} aria-label={t('player.music.next')}>{I.right}</button>
          <button className="btn line" onClick={remove}>{t('player.music.delete')}</button>
        </div>
      </div>
      <section className="sec" aria-labelledby="h-tracks">
        <div className="sec-h"><h2 id="h-tracks">{t('player.music.tracks')}</h2><span className="count">{t('library.music.tracks', { count: music.songs })}</span></div>
        <ol style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {Array.from({ length: music.songs }, (_, k) => (
            <li key={k}>
              <button className={k === track ? 'btn y' : 'btn line'} aria-current={k === track || undefined} onClick={() => setTrack(k)}>
                {t('player.music.track', { n: k + 1 })}
              </button>
            </li>
          ))}
        </ol>
      </section>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </main>
  );
}
