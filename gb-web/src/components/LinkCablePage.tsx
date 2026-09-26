import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useLinkCable, type LinkPlayer } from '../hooks/useLinkCable';
import { fetchRom, useGameLibrary } from '../hooks/useGameLibrary';
import { linkReady as isLinkReady, owned, PLATFORM, sortTitle } from '../lib/ui';
import type { GameEntry } from '../types/game';
import { CartridgePicker } from './CartridgePicker';
import { Item } from './library/GameItem';
import { Cover, NoArt } from './library/Cover';
import { I } from './icons';
import { toast } from './shell/actions';

// Fixed two-player keys: player 1 on the right of the keyboard, player 2 on the left.
// Values are the core's button numbers (A 0, B 1, Select 2, Start 3, Right 4, Left 5, Up 6, Down 7).
const KEYS: Record<LinkPlayer, Record<string, number>> = {
  1: { ArrowUp: 6, ArrowDown: 7, ArrowLeft: 5, ArrowRight: 4, z: 0, x: 1, Enter: 3, Shift: 2 },
  2: { w: 6, s: 7, a: 5, d: 4, n: 0, m: 1, t: 3, y: 2 },
};
const LEGEND: Record<LinkPlayer, string> = { 1: 'Arrows · Z · X · Enter · Shift', 2: 'W A S D · N · M · T · Y' };
const FILE = '__file';

export function LinkCablePage() {
  const { games, savedIds, loading } = useGameLibrary();
  const [q] = useSearchParams();
  const link = useLinkCable();
  const { state } = link;
  const playable = useMemo(() => games.filter(owned).sort((a, b) => +isLinkReady(b) - +isLinkReady(a) || sortTitle(a.title).localeCompare(sortTitle(b.title))), [games]);
  const linkReady = playable.filter(isLinkReady);
  const first = (q.get('g') && playable.some((g) => g.id === q.get('g')) ? q.get('g') : playable[0]?.id) ?? '';
  const [pick, setPick] = useState<Record<LinkPlayer, string>>({ 1: '', 2: '' });
  const [files, setFiles] = useState<Record<LinkPlayer, File | null>>({ 1: null, 2: null });
  const [same, setSame] = useState(true);
  const [picking, setPicking] = useState<LinkPlayer | null>(null);
  const fileInput = useRef<Record<LinkPlayer, HTMLInputElement | null>>({ 1: null, 2: null });
  const sel1 = pick[1] || first;
  const sel: Record<LinkPlayer, string> = { 1: sel1, 2: same ? sel1 : pick[2] || first };
  const fileOf = (p: LinkPlayer) => (same && p === 2 ? files[1] : files[p]);

  useEffect(() => { document.title = 'Link cable · Cartouche'; }, []);

  const choose = (p: LinkPlayer, v: string) => {
    if (v === FILE) { fileInput.current[p]?.click(); return; }
    setPick((s) => ({ ...s, [p]: v }));
  };
  const romFor = async (p: LinkPlayer): Promise<Uint8Array | null> => {
    const f = fileOf(p);
    if (sel[p] === FILE && f) return new Uint8Array(await f.arrayBuffer());
    const g = playable.find((x) => x.id === sel[p]);
    return g ? fetchRom(g) : null;
  };
  const connect = async () => {
    if (state.isRunning) { link.stop(); toast('Cable disconnected', 'c'); return; }
    try {
      const [a, b] = await Promise.all([romFor(1), romFor(2)]);
      if (!a || !b) { toast('Pick a game for both players', 'm'); return; }
      link.loadRom(1, a);
      link.loadRom(2, b);
      link.start(); // the workers handle messages in order: each ROM is loaded before the first frame runs
      toast('Cable connected. Both players are running.', 'c');
    } catch (e) {
      toast(`Couldn’t load the ROM: ${e instanceof Error ? e.message : e}`, 'm');
    }
  };

  // Both players' keys, only while the cable is connected.
  const { setInput } = link;
  useEffect(() => {
    if (!state.isRunning) return;
    const held: Record<LinkPlayer, number> = { 1: 0, 2: 0 };
    const on = (down: boolean) => (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      for (const p of [1, 2] as LinkPlayer[]) {
        const b = KEYS[p][key];
        if (b === undefined) continue;
        e.preventDefault();
        const next = down ? held[p] | (1 << b) : held[p] & ~(1 << b);
        if (next !== held[p]) { held[p] = next; setInput(p, next); }
      }
    };
    const down = on(true), up = on(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); setInput(1, 0); setInput(2, 0); };
  }, [state.isRunning, setInput]);

  const ready = state.p1Ready && state.p2Ready;
  /** The cartridge in a player's slot: box, title, platform, link support, and the "Change" button. */
  const cart = (p: LinkPlayer, f: File | null) => {
    const g: GameEntry | undefined = sel[p] === FILE ? undefined : playable.find((x) => x.id === sel[p]);
    const mirror = p === 2 && same;
    const title = g?.title ?? (sel[p] === FILE && f ? f.name : '');
    const note = mirror ? 'Same cartridge as Player 1. Turn off “Same game for both players” to choose another.'
      : g && isLinkReady(g) ? '2 players: uses the link cable'
      : g?.players === 1 ? 'Single-player: may not use the cable'
      : '';
    return (
      <div className="cart">
        <div className="box" aria-hidden="true">{g ? <Cover game={g} /> : title ? <span className="cv"><NoArt game={{ title, genre: 'Unknown' } as GameEntry} /></span> : <span className="cv none">{I.cart}</span>}</div>
        <div className="info">
          {title ? <b>{title}</b> : <b className="dim">No cartridge</b>}
          <small>{g?.platform ? PLATFORM[g.platform] : f && sel[p] === FILE ? 'ROM file' : ''}{g && isLinkReady(g) && <span className="tag now">{I.link}Link-ready</span>}</small>
          {note && <small id={`note-p${p}`}>{note}</small>}
        </div>
        <button className="btn line" disabled={state.isRunning || mirror} aria-describedby={note ? `note-p${p}` : undefined}
          aria-label={title ? `Change Player ${p} cartridge (${title})` : `Choose a cartridge for Player ${p}`} onClick={(e) => { e.currentTarget.focus(); setPicking(p); }}>
          {title ? 'Change' : 'Choose a cartridge'}
        </button>
      </div>
    );
  };
  const panel = (p: LinkPlayer) => {
    const f = fileOf(p);
    return (
      <section className="player" aria-labelledby={`h-p${p}`}>
        <h2 id={`h-p${p}`}><i style={{ background: p === 1 ? 'var(--c)' : 'var(--m)' }} />Player {p}</h2>
        <div className="ctl">{LEGEND[p]}</div>
        <div className="frame">
          <canvas ref={p === 1 ? link.p1CanvasRef : link.p2CanvasRef} className="lcd" width={160} height={144} aria-label={`Player ${p} screen`} />
        </div>
        {cart(p, f)}
        <input ref={(el) => { fileInput.current[p] = el; }} type="file" accept=".gb,.gbc,.rom,.bin" className="sr" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setFiles((s) => ({ ...s, [p]: file })); setPick((s) => ({ ...s, [p]: FILE })); }} />
      </section>
    );
  };

  return (
    <main className="wrap">
      <div className="pagehead">
        <h1>Link cable</h1>
        <p>Two Game Boys on one screen, joined by a virtual cable. Player 2 uses the left side of the keyboard. Both consoles run in lockstep and the cable carries their serial data; games with timing-sensitive link protocols may still fail to connect.</p>
      </div>
      <div className="lc">
        {panel(1)}
        <div className={`cable${state.isRunning ? ' on' : ''}`} aria-live="polite"><i /><span>{state.isRunning ? 'Linked' : ready ? 'Idle' : 'Starting…'}</span><i /></div>
        {panel(2)}
      </div>
      {state.error && <p className="note" role="alert">{state.error}</p>}
      <div className="lc-bar">
        <div className="row" style={{ border: 0, padding: 0, gap: 14, color: 'var(--paper)' }}>
          <button className="switch" role="switch" aria-checked={same} aria-label="Same game for both players" disabled={state.isRunning} onClick={() => setSame(!same)} />
          Same game for both players
        </div>
        <div className="acts">
          <button className="btn y lg" disabled={!ready || loading || (!playable.length && !files[1])} onClick={connect}>
            {state.isRunning ? <>{I.close}Disconnect</> : <>{I.link}Connect &amp; start</>}
          </button>
        </div>
      </div>
      <CartridgePicker open={picking !== null} player={picking ?? 1} games={playable} current={picking ? sel[picking] : undefined}
        onPick={(id) => picking && choose(picking, id)} onFile={() => picking && choose(picking, FILE)} onClose={() => setPicking(null)} />
      <section className="sec compat" aria-labelledby="h-compat">
        <div className="sec-h"><h2 id="h-compat">Link-ready in your library</h2><span className="count">Games that use the link port</span></div>
        {linkReady.length
          ? <div className="shelf">{linkReady.map((g) => <Item key={g.id} game={g} saved={savedIds} />)}</div>
          : <p className="shelf-empty">None yet. Two-player games you add show up here.</p>}
      </section>
    </main>
  );
}
