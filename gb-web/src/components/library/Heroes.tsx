import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import type { GameEntry } from '../../types/game';
import type { StoredSaveState } from '../../lib/db';
import { getLatestSaveState } from '../../lib/db';
import { useInk } from '../../hooks/useInk';
import { fetchRom } from '../../hooks/useGameLibrary';
import { ago, byline, dur, paths } from '../../lib/ui';
import { I } from '../icons';
import { Cover, Title } from './Cover';

/** Latest resume point / save slot of a game, undefined while loading, null when there is none. */
function useLatestSave(gameId: string) {
  const [state, setState] = useState<{ id: string; save: StoredSaveState | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    getLatestSaveState(gameId).then((s) => { if (!cancelled) setState({ id: gameId, save: s ?? null }); }).catch(() => {});
    return () => { cancelled = true; };
  }, [gameId]);
  return state?.id === gameId ? state.save : undefined;
}

/** A 160×144 RGBA frame (save-state thumbnail) painted at native resolution. */
export function Frame({ rgba, label }: { rgba: Uint8Array; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx || rgba.length !== 160 * 144 * 4) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), 160, 144), 0, 0);
  }, [rgba]);
  return <canvas ref={ref} className="lcd" width={160} height={144} aria-label={label} role="img" />;
}

/**
 * Attract mode: runs the game muted in the real emulator core, only while on screen.
 * With reduced motion it runs a few seconds off screen and shows a single still frame.
 */
function Attract({ game, label }: { game?: GameEntry; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !game) return;
    let raf = 0, stopped = false, onScreen = true;
    let emu: import('gb-core').Emulator | null = null;
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; });
    io.observe(canvas);
    (async () => {
      const [wasm, rom] = await Promise.all([import('gb-core'), fetchRom(game)]);
      await wasm.default();
      if (stopped) return;
      emu = new wasm.Emulator();
      if (!emu.load_rom(rom)) return;
      const ctx = canvas.getContext('2d')!;
      const img = ctx.createImageData(160, 144);
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Fast-forward past the boot sequence before the first frame is shown; a still waits ~5 s for the title screen.
      const warmup = still ? 300 : 150;
      let frames = 0;
      const step = () => { const ok = emu!.run_frame(); emu!.clear_audio_buffer(); frames++; return ok; }; // silent: audio is dropped
      const draw = () => { img.data.set(emu!.framebuffer_snapshot()); ctx.putImageData(img, 0, 0); };
      const tick = () => {
        if (stopped || !emu) return;
        if (frames < warmup) {
          for (let i = 0; i < 30; i++) if (!step()) return;
          if (still && frames >= warmup) { draw(); return; }
        } else if (onScreen) {
          if (!step()) return;
          draw();
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })().catch(() => { /* no ROM or no WASM: the frame stays dark */ });
    return () => { stopped = true; cancelAnimationFrame(raf); io.disconnect(); emu?.free(); emu = null; };
  }, [game]);
  return <canvas ref={ref} className="lcd" width={160} height={144} aria-label={label} role="img" />;
}

/** "Continue playing" / "Ready to play": the most recent game, flooded with its own ink. */
export function ContinueHero({ game }: { game: GameEntry }) {
  const ink = useInk(game);
  const save = useLatestSave(game.id);
  const played = !!game.lastPlayed;
  const sub = byline(game);
  return (
    <section className="flood cont" style={{ '--flood': ink } as CSSProperties} aria-label={played ? 'Continue playing' : 'Ready to play'}>
      <div className="wrap">
        <Link to={paths.game(game.id)} className="box" aria-label={`${game.title} details`}><Cover game={game} className="boxart" /></Link>
        <div className="info">
          <h1 className="hero-t"><Title text={game.title} /></h1>
          <p className="meta">
            {played
              ? <><span><strong>Played {ago(game.lastPlayed!)}</strong>{save ? ' · resume point saved' : ''}</span><span>{dur(game.totalPlayTime)} played</span></>
              : <span><strong>{game.importedAt ? `Added ${ago(game.importedAt)}` : 'On your shelf'}</strong> · not played yet</span>}
            {sub && <span>{sub}</span>}
          </p>
          <div className="acts">
            <Link className="btn lg play" to={paths.play(game.id, save ? '?resume=1' : '')}>{I.play}{save ? 'Continue' : 'Play'}</Link>
            {save
              ? <Link className="btn lg line" to={paths.play(game.id, '?tab=saves')}>Save slots</Link>
              : <Link className="btn lg line" to={paths.game(game.id)}>About the game</Link>}
          </div>
        </div>
        <figure className="shot" style={{ margin: 0 }} data-game={game.id}>
          <div className="frame">
            {save?.thumbnail?.length ? <Frame rgba={save.thumbnail} label="Last frame" /> : save === undefined ? <canvas className="lcd" width={160} height={144} aria-hidden="true" /> : <Attract game={game} label={`${game.title} demo`} />}
          </div>
          <figcaption className="cap">
            <span>{save ? 'Where you left off' : 'Ready in the slot'}</span><i /><span>{save ? ago(save.timestamp) : 'Press play'}</span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

/** First launch: nothing stored yet, so this hero shows nothing it would have to download. */
export function FirstHero({ bundled }: { bundled?: GameEntry }) {
  return (
    <section className="first" aria-label="Welcome">
      <div className="wrap">
        <div>
          <h1 className="hero-t">Put your games on the shelf.</h1>
          <p className="lede">Drop the .gb and .gbc files you own anywhere on this page. Each one is identified by its SHA-1 fingerprint against thousands of known Game Boy and Game Boy Color dumps, gets its details, and stays in this browser.</p>
          <div className="acts">
            <Link className="btn k lg" to="/add">{I.plus}Add your ROMs</Link>
            {bundled && <Link className="btn lg line" to={paths.play(bundled.id)}>{I.play}Play {bundled.title} now</Link>}
          </div>
          <ol className="steps">
            <li><b>Add your ROMs</b><span>Drop files anywhere, several at once.</span></li>
            <li><b>Recognized</b><span>Title, developer and year arrive by themselves.</span></li>
            <li><b>Play anywhere</b><span>Keyboard, gamepad or touch. Saves stay here.</span></li>
          </ol>
        </div>
        {bundled && (
          <figure className="shot" style={{ margin: 0 }} data-game={bundled.id}>
            <div className="frame"><Attract game={bundled} label={`${bundled.title} demo`} /></div>
            <figcaption className="cap"><span>{bundled.title} comes with the app</span><i /><span>Free homebrew</span></figcaption>
          </figure>
        )}
      </div>
    </section>
  );
}
