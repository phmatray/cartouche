import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useLinkCable, type LinkPlayer } from '../hooks/useLinkCable';
import { fetchRom, refreshSavedIds, useGameLibrary } from '../hooks/useGameLibrary';
import { importSav, useRomHeader } from '../hooks/useGameExtras';
import { createProfile, getActiveProfileId, getGameSaveStates, getSaveState, getSram, listProfiles, newProfileId, resumeStateId, saveSram, slotStateId, uniqueName, type StoredSave, type StoredSaveState } from '../lib/db';
import { useSettingsStore } from '../store/settingsStore';
import { ago, bytes, linkReady as isLinkReady, owned, PLATFORM, sortTitle } from '../lib/ui';
import type { GameEntry } from '../types/game';
import { CartridgePicker } from './CartridgePicker';
import { Item } from './library/GameItem';
import { Cover, NoArt } from './library/Cover';
import { I } from './icons';
import { toast } from './shell/actions';
import { fileAccept } from '../lib/pwa';

// Fixed two-player keys: player 1 on the right of the keyboard, player 2 on the left.
// Values are the core's button numbers (A 0, B 1, Select 2, Start 3, Right 4, Left 5, Up 6, Down 7).
const KEYS: Record<LinkPlayer, Record<string, number>> = {
  1: { ArrowUp: 6, ArrowDown: 7, ArrowLeft: 5, ArrowRight: 4, z: 0, x: 1, Enter: 3, Shift: 2 },
  2: { w: 6, s: 7, a: 5, d: 4, n: 0, m: 1, t: 3, y: 2 },
};
const LEGEND: Record<LinkPlayer, string> = { 1: 'Arrows · Z · X · Enter · Shift', 2: 'W A S D · N · M · T · Y' };
const FILE = '__file';

/**
 * A player's battery save: the profile its console writes to (`profile`, which may not exist yet: a new
 * game is created on the first write, named `name`), started from that save or from a save state (`slot`).
 */
interface Choice { game: string; profile: string; name: string; slot: 'auto' | number | null }
interface GameSaves { profiles: StoredSave[]; active: string; states: (StoredSaveState | undefined)[] }
async function savesOf(g: string): Promise<GameSaves> {
  const [profiles, active, states] = await Promise.all([listProfiles(g), getActiveProfileId(g), getGameSaveStates(g)]);
  return { profiles, active, states };
}
const slotLabel = (k: 'auto' | number) => (k === 'auto' ? 'the resume point' : `save slot ${k + 1}`);

export function LinkCablePage() {
  const { games, savedIds, loading } = useGameLibrary();
  const [q] = useSearchParams();
  // Where each console's battery save goes, fixed when the cable connects.
  const targets = useRef<Record<LinkPlayer, Choice | null>>({ 1: null, 2: null });
  const [linked, setLinked] = useState<Record<LinkPlayer, Choice | null>>({ 1: null, 2: null }); // the same, for display
  const [wrote, setWrote] = useState<Record<LinkPlayer, number>>({ 1: 0, 2: 0 });
  const [data, setData] = useState<Record<string, GameSaves>>({});
  const refresh = useCallback(async (g: string) => {
    const v = await savesOf(g);
    setData((d) => ({ ...d, [g]: v }));
  }, []);
  const dataRef = useRef(data); // the profiles as last read, for onSram
  useEffect(() => { dataRef.current = data; }, [data]);
  const onSram = useCallback((saves: [Uint8Array | null, Uint8Array | null]) => {
    for (const p of [1, 2] as LinkPlayer[]) {
      const t = targets.current[p], sram = saves[p - 1];
      if (!t || !sram?.length) continue;
      // A single put, not read-then-write: when the page is unloading, a second step never runs.
      const now = Date.now(), old = dataRef.current[t.game]?.profiles.find((x) => x.id === t.profile);
      saveSram(old ? { ...old, sram, timestamp: now } : { id: t.profile, gameId: t.game, name: t.name, sram, timestamp: now, created: now }).then(() => {
        setWrote((w) => ({ ...w, [p]: Date.now() }));
        refresh(t.game).catch(() => {});
        refreshSavedIds();
      }).catch(() => toast(`Couldn’t save Player ${p}’s game`, 'm'));
    }
  }, [refresh]);
  const link = useLinkCable(onSram);
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
  const gameOf = (p: LinkPlayer) => (sel[p] === FILE ? undefined : playable.find((x) => x.id === sel[p]));
  const header1 = useRomHeader(gameOf(1)), header2 = useRomHeader(gameOf(2));
  const [chosen, setChosen] = useState<Record<LinkPlayer, Choice | null>>({ 1: null, 2: null });
  const [savErr, setSavErr] = useState<Record<LinkPlayer, string>>({ 1: '', 2: '' });
  const savInput = useRef<Record<LinkPlayer, HTMLInputElement | null>>({ 1: null, 2: null });
  const [s1, s2] = [sel[1], sel[2]];
  useEffect(() => {
    for (const g of new Set([s1, s2])) {
      if (g && g !== FILE && !data[g]) savesOf(g).then((v) => setData((d) => ({ ...d, [g]: v }))).catch(() => {}); // storage blocked: no chooser
    }
  }, [s1, s2, data]);

  /** Player 1 plays the game's solo save; Player 2 its own "Player 2" save (created on the first write), never Player 1's. */
  const choiceOf = (p: LinkPlayer): Choice | null => {
    const g = sel[p], d = data[g];
    if (chosen[p]?.game === g) return chosen[p];
    if (!d || g === FILE) return null;
    if (p === 1) return { game: g, profile: d.active, name: d.profiles.find((x) => x.id === d.active)?.name ?? 'Main', slot: null };
    const taken = sel[1] === g ? choiceOf(1)?.profile : undefined;
    const mine = d.profiles.find((x) => x.id !== taken && (x.id === `${g}~p2` || x.name === 'Player 2'));
    if (mine) return { game: g, profile: mine.id, name: mine.name, slot: null };
    let id = `${g}~p2`;
    for (let n = 2; id === taken || d.profiles.some((x) => x.id === id); n++) id = `${g}~p2-${n}`;
    return { game: g, profile: id, name: uniqueName(d.profiles, 'Player 2'), slot: null };
  };
  const choice: Record<LinkPlayer, Choice | null> = { 1: choiceOf(1), 2: choiceOf(2) };
  const clash = !!choice[1] && !!choice[2] && choice[1].game === choice[2].game && choice[1].profile === choice[2].profile;
  const nameOf = (c: Choice) => data[c.game]?.profiles.find((x) => x.id === c.profile)?.name ?? c.name;

  const pickSave = (p: LinkPlayer, v: string) => {
    const g = sel[p], d = data[g];
    if (!d) return;
    setSavErr((e) => ({ ...e, [p]: '' }));
    if (v === 'new') { setChosen((c) => ({ ...c, [p]: { game: g, profile: newProfileId(g), name: uniqueName(d.profiles, `Player ${p}`), slot: null } })); return; }
    if (v.startsWith('slot:')) {
      const k = v === 'slot:auto' ? 'auto' : +v.slice(5);
      const st = d.states[k === 'auto' ? 0 : k + 1];
      const owner = d.profiles.find((x) => x.id === (st?.profile ?? g)); // states from before profiles belong to Main
      // Its save was deleted: it goes to a new one (as in solo play), never to another save under a borrowed name.
      const to = owner ?? { id: newProfileId(g), name: uniqueName(d.profiles, k === 'auto' ? 'From the resume point' : `From save slot ${k + 1}`) };
      setChosen((c) => ({ ...c, [p]: { game: g, profile: to.id, name: to.name, slot: k } }));
      return;
    }
    const id = v.slice(2), c = choice[p];
    setChosen((s) => ({ ...s, [p]: { game: g, profile: id, name: d.profiles.find((x) => x.id === id)?.name ?? c?.name ?? 'Main', slot: null } }));
  };
  const onSav = async (p: LinkPlayer, f: File) => {
    const g = gameOf(p);
    if (!g) return;
    const r = await importSav(g, f).catch((e) => `${f.name}: ${e instanceof Error ? e.message : e}`);
    if (typeof r === 'string') { setSavErr((e) => ({ ...e, [p]: r })); return; }
    await refresh(g.id);
    setChosen((c) => ({ ...c, [p]: { game: g.id, profile: r.id, name: r.name, slot: null } }));
    toast(`“${r.name}” imported for Player ${p}`, 'c');
  };
  /** Both players on one save: Player 2 gets a copy of it (a new, separate save). */
  const copyForP2 = async () => {
    const c = choice[2], d = c && data[c.game];
    if (!c || !d) return;
    const src = d.profiles.find((x) => x.id === c.profile);
    const name = uniqueName(d.profiles, `${nameOf(c)} (copy)`);
    const id = src ? (await createProfile(c.game, name, src.sram)).id : newProfileId(c.game);
    await refresh(c.game);
    setChosen((s) => ({ ...s, 2: { ...c, profile: id, name } }));
    toast(`Player 2 now plays “${name}”`, 'c');
  };

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
    if (state.isRunning) { link.flush(); link.stop(); toast('Cable disconnected. Both games saved.', 'c'); return; }
    if (clash) return;
    try {
      const [a, b] = await Promise.all([romFor(1), romFor(2)]);
      if (!a || !b) { toast('Pick a game for both players', 'm'); return; }
      const from = async (c: Choice | null) => {
        if (!c) return {};
        if (c.slot === null) return { sram: (await getSram(c.profile))?.sram };
        const st = await getSaveState(c.slot === 'auto' ? resumeStateId(c.game) : slotStateId(c.game, c.slot));
        if (!st) throw new Error(`${slotLabel(c.slot)} is gone`);
        return { state: st.data };
      };
      const [f1, f2] = await Promise.all([from(choice[1]), from(choice[2])]);
      targets.current = { 1: choice[1], 2: choice[2] };
      setLinked(targets.current);
      setWrote({ 1: 0, 2: 0 });
      link.loadRom(1, a, f1);
      link.loadRom(2, b, f2);
      link.start(); // the workers handle messages in order: each ROM is loaded before the first frame runs
      toast('Cable connected. Both players are running.', 'c');
    } catch (e) {
      toast(`Couldn’t load the ROM: ${e instanceof Error ? e.message : e}`, 'm');
    }
  };

  // Battery saves while linked: at the Settings interval (like solo play) and when the tab is hidden or closed.
  const autoSave = useSettingsStore((s) => s.autoSaveEnabled);
  const autoSeconds = useSettingsStore((s) => s.autoSaveIntervalSeconds);
  const { flush, flushNow } = link;
  useEffect(() => {
    if (!state.isRunning) return;
    const t = autoSave ? window.setInterval(flush, autoSeconds * 1000) : 0;
    // Hidden or closing: write the saves already here now (a reload or tab close never gets the worker's reply), then ask for fresher ones.
    const leave = () => { flushNow(); flush(); };
    const onHide = () => { if (document.visibilityState === 'hidden') leave(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', leave);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', leave); };
  }, [state.isRunning, autoSave, autoSeconds, flush, flushNow]);

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
  /** The battery save a player plays: its game's profiles, a new game, a .sav file, or a save state. */
  const saveChooser = (p: LinkPlayer) => {
    const g = gameOf(p), c = choice[p], d = g && data[g.id], h = p === 1 ? header1 : header2;
    if (sel[p] === FILE) return fileOf(p) ? <div className="svp"><small>A ROM file outside your library: its save isn’t kept.</small></div> : null;
    if (!g || !c || !d) return null;
    if (h && h.ramSize === 'None' && !/MBC2/.test(h.cartridgeType)) return <div className="svp"><small>This cartridge has no battery save.</small></div>;
    const known = d.profiles.find((x) => x.id === c.profile);
    const t = linked[p];
    const live = state.isRunning || !!wrote[p];
    return (
      <div className="svp">
        <label className="sel"><span>Save</span>
          <select value={c.slot !== null ? `slot:${c.slot}` : `p:${c.profile}`} disabled={state.isRunning} aria-describedby={`svp-s${p}`}
            aria-label={`Player ${p} save`} onChange={(e) => pickSave(p, e.target.value)}>
            <optgroup label="Games">
              {d.profiles.map((x) => <option key={x.id} value={`p:${x.id}`}>{x.name} · {ago(x.timestamp)} · {bytes(x.sram.length)}</option>)}
              {!known && c.slot === null && <option value={`p:${c.profile}`}>{c.name} · new game</option>}
            </optgroup>
            <option value="new">New game (empty save)</option>
            {d.states.some(Boolean) && (
              <optgroup label="Start from a save state">
                {d.states.map((st, i) => st && <option key={i} value={i ? `slot:${i - 1}` : 'slot:auto'}>{i ? `Save slot ${i}` : 'Resume point'} · {ago(st.timestamp)}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        {!state.isRunning && <button className="btn line svp-imp" aria-label={`Import a .sav file for Player ${p}`} onClick={() => savInput.current[p]?.click()}>{I.load}Import a .sav file…</button>}
        <small id={`svp-s${p}`} aria-live="polite">
          {live && t ? <>Saving to <b>{nameOf(t)}</b>{wrote[p] ? `, saved ${ago(wrote[p])}` : ''}</>
            : c.slot !== null ? <>Starts from {slotLabel(c.slot)}, then saves to <b>{nameOf(c)}</b>{known ? '' : ' (new)'}</>
            : known ? <>Continues <b>{known.name}</b> and saves back to it</>
            : <>A new game, saved as <b>{c.name}</b></>}
        </small>
        {savErr[p] && <small className="bad" role="alert">{savErr[p]}</small>}
        <input ref={(el) => { savInput.current[p] = el; }} type="file" accept={fileAccept('.sav,.srm')} className="sr" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) onSav(p, file); }} />
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
        {saveChooser(p)}
        <input ref={(el) => { fileInput.current[p] = el; }} type="file" accept={fileAccept('.gb,.gbc,.rom,.bin')} className="sr" tabIndex={-1} aria-hidden="true"
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
      {clash && !state.isRunning && (
        <div className="svp-warn" role="alert" style={{ marginTop: 16 }}>
          <p>Both players would play and save <b>{nameOf(choice[1]!)}</b>: the two consoles would overwrite each other’s progress. Each player needs a save of their own.</p>
          <button className="btn p" onClick={copyForP2}>Use a copy for Player 2</button>
        </div>
      )}
      {state.error && <p className="note" role="alert">{state.error}</p>}
      <div className="lc-bar">
        <div className="row" style={{ border: 0, padding: 0, gap: 14, color: 'var(--paper)' }}>
          <button className="switch" role="switch" aria-checked={same} aria-label="Same game for both players" disabled={state.isRunning} onClick={() => setSame(!same)} />
          Same game for both players
        </div>
        <div className="acts">
          <button className="btn y lg" disabled={!ready || loading || (!playable.length && !files[1]) || (clash && !state.isRunning)} onClick={connect}>
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
