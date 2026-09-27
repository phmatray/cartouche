import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useLinkCable, type LinkPlayer } from '../hooks/useLinkCable';
import { fetchRom, refreshSavedIds, useGameLibrary } from '../hooks/useGameLibrary';
import { importSav, readRomFile, useRomHeader } from '../hooks/useGameExtras';
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
import { holdLinkCable } from '../lib/play-lock';
import { rich, t as tNow, useT } from '../i18n';

// Fixed two-player keys: player 1 on the right of the keyboard, player 2 on the left.
// Values are the core's button numbers (A 0, B 1, Select 2, Start 3, Right 4, Left 5, Up 6, Down 7).
const KEYS: Record<LinkPlayer, Record<string, number>> = {
  1: { ArrowUp: 6, ArrowDown: 7, ArrowLeft: 5, ArrowRight: 4, z: 0, x: 1, Enter: 3, Shift: 2 },
  2: { w: 6, s: 7, a: 5, d: 4, n: 0, m: 1, t: 3, y: 2 },
};
const LEGEND: Record<LinkPlayer, string> = { 1: '{arrows} · Z · X · Enter · Shift', 2: 'W A S D · N · M · T · Y' };
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
const slotLabel = (k: 'auto' | number) => (k === 'auto' ? tNow('link.save.theResume') : tNow('link.save.theSlot', { n: String(k + 1) }));

export function LinkCablePage() {
  const { games, savedIds, loading } = useGameLibrary();
  const t = useT();
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
      }).catch(() => toast(tNow('link.toast.saveFailed', { p: String(p) }), 'm'));
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
    if (p === 1) return { game: g, profile: d.active, name: d.profiles.find((x) => x.id === d.active)?.name ?? t('player.saves.main'), slot: null };
    const taken = sel[1] === g ? choiceOf(1)?.profile : undefined;
    const mine = d.profiles.find((x) => x.id !== taken && (x.id === `${g}~p2` || x.id.startsWith(`${g}~p2-`) || x.name === 'Player 2' || x.name === t('link.player', { p: '2' })));
    if (mine) return { game: g, profile: mine.id, name: mine.name, slot: null };
    let id = `${g}~p2`;
    for (let n = 2; id === taken || d.profiles.some((x) => x.id === id); n++) id = `${g}~p2-${n}`;
    return { game: g, profile: id, name: uniqueName(d.profiles, t('link.player', { p: '2' })), slot: null };
  };
  const choice: Record<LinkPlayer, Choice | null> = { 1: choiceOf(1), 2: choiceOf(2) };
  const clash = !!choice[1] && !!choice[2] && choice[1].game === choice[2].game && choice[1].profile === choice[2].profile;
  const nameOf = (c: Choice) => data[c.game]?.profiles.find((x) => x.id === c.profile)?.name ?? c.name;

  const pickSave = (p: LinkPlayer, v: string) => {
    const g = sel[p], d = data[g];
    if (!d) return;
    setSavErr((e) => ({ ...e, [p]: '' }));
    if (v === 'new') { setChosen((c) => ({ ...c, [p]: { game: g, profile: newProfileId(g), name: uniqueName(d.profiles, t('link.player', { p: String(p) })), slot: null } })); return; }
    if (v.startsWith('slot:')) {
      const k = v === 'slot:auto' ? 'auto' : +v.slice(5);
      const st = d.states[k === 'auto' ? 0 : k + 1];
      const owner = d.profiles.find((x) => x.id === (st?.profile ?? g)); // states from before profiles belong to Main
      // Its save was deleted: it goes to a new one (as in solo play), never to another save under a borrowed name.
      const to = owner ?? { id: newProfileId(g), name: uniqueName(d.profiles, k === 'auto' ? t('player.saves.fromResume') : t('player.saves.fromSlot', { n: String(k + 1) })) };
      setChosen((c) => ({ ...c, [p]: { game: g, profile: to.id, name: to.name, slot: k } }));
      return;
    }
    const id = v.slice(2), c = choice[p];
    setChosen((s) => ({ ...s, [p]: { game: g, profile: id, name: d.profiles.find((x) => x.id === id)?.name ?? c?.name ?? t('player.saves.main'), slot: null } }));
  };
  const onSav = async (p: LinkPlayer, f: File) => {
    const g = gameOf(p);
    if (!g) return;
    const r = await importSav(g, f).catch((e) => `${f.name}: ${e instanceof Error ? e.message : e}`);
    if (typeof r === 'string') { setSavErr((e) => ({ ...e, [p]: r })); return; }
    await refresh(g.id);
    setChosen((c) => ({ ...c, [p]: { game: g.id, profile: r.id, name: r.name, slot: null } }));
    toast(tNow('link.toast.imported', { name: r.name, p: String(p) }), 'c');
  };
  /** Both players on one save: Player 2 gets a copy of it (a new, separate save). */
  const copyForP2 = async () => {
    const c = choice[2], d = c && data[c.game];
    if (!c || !d) return;
    const src = d.profiles.find((x) => x.id === c.profile);
    const name = uniqueName(d.profiles, tNow('game.saves.copyName', { name: nameOf(c) }));
    const id = src ? (await createProfile(c.game, name, src.sram)).id : newProfileId(c.game);
    await refresh(c.game);
    setChosen((s) => ({ ...s, 2: { ...c, profile: id, name } }));
    toast(tNow('link.toast.p2Plays', { name }), 'c');
  };

  useEffect(() => { document.title = t('common.docTitle', { page: t('link.title') }); }, [t]);
  useEffect(() => holdLinkCable(), []); // sync in another tab leaves every save alone meanwhile (lib/play-lock)

  const choose = (p: LinkPlayer, v: string) => {
    if (v === FILE) { fileInput.current[p]?.click(); return; }
    setPick((s) => ({ ...s, [p]: v }));
  };
  const romFor = async (p: LinkPlayer): Promise<Uint8Array | null> => {
    const f = fileOf(p);
    if (sel[p] === FILE && f) return readRomFile(f);
    const g = playable.find((x) => x.id === sel[p]);
    return g ? fetchRom(g) : null;
  };
  const connect = async () => {
    if (state.isRunning) { link.flush(); link.stop(); toast(tNow('link.toast.disconnected'), 'c'); return; }
    if (clash) return;
    try {
      const [a, b] = await Promise.all([romFor(1), romFor(2)]);
      if (!a || !b) { toast(tNow('link.toast.pick'), 'm'); return; }
      const from = async (c: Choice | null) => {
        if (!c) return {};
        if (c.slot === null) return { sram: (await getSram(c.profile))?.sram };
        const st = await getSaveState(c.slot === 'auto' ? resumeStateId(c.game) : slotStateId(c.game, c.slot));
        if (!st) throw new Error(tNow('link.toast.gone', { slot: slotLabel(c.slot) }));
        return { state: st.data };
      };
      const [f1, f2] = await Promise.all([from(choice[1]), from(choice[2])]);
      targets.current = { 1: choice[1], 2: choice[2] };
      setLinked(targets.current);
      setWrote({ 1: 0, 2: 0 });
      link.loadRom(1, a, f1);
      link.loadRom(2, b, f2);
      link.start(); // the workers handle messages in order: each ROM is loaded before the first frame runs
      toast(tNow('link.toast.connected'), 'c');
    } catch (e) {
      toast(tNow('player.toast.loadFailed', { error: e instanceof Error ? e.message : String(e) }), 'm');
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
    window.addEventListener('beforeunload', leave); // WebKit drops a write issued in pagehide during a reload or close
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('beforeunload', leave);
    };
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
    const note = mirror ? t('link.cart.mirror')
      : g && isLinkReady(g) ? t('link.cart.two')
      : g?.players === 1 ? t('link.cart.single')
      : '';
    return (
      <div className="cart">
        <div className="box" aria-hidden="true">{g ? <Cover game={g} /> : title ? <span className="cv"><NoArt game={{ title, genre: 'Unknown' } as GameEntry} /></span> : <span className="cv none">{I.cart}</span>}</div>
        <div className="info">
          {title ? <b>{title}</b> : <b className="dim">{t('link.cart.none')}</b>}
          <small>{g?.platform ? PLATFORM[g.platform] : f && sel[p] === FILE ? t('link.cart.file') : ''}{g && isLinkReady(g) && <span className="tag now">{I.link}{t('link.ready')}</span>}</small>
          {note && <small id={`note-p${p}`}>{note}</small>}
        </div>
        <button className="btn line" disabled={state.isRunning || mirror} aria-describedby={note ? `note-p${p}` : undefined}
          aria-label={title ? t('link.cart.changeOf', { p: String(p), title }) : t('link.cart.chooseFor', { p: String(p) })} onClick={(e) => { e.currentTarget.focus(); setPicking(p); }}>
          {title ? t('link.cart.change') : t('link.cart.choose')}
        </button>
      </div>
    );
  };
  /** The battery save a player plays: its game's profiles, a new game, a .sav file, or a save state. */
  const saveChooser = (p: LinkPlayer) => {
    const g = gameOf(p), c = choice[p], d = g && data[g.id], h = p === 1 ? header1 : header2;
    if (sel[p] === FILE) return fileOf(p) ? <div className="svp"><small>{t('link.save.file')}</small></div> : null;
    if (!g || !c || !d) return null;
    if (h && h.ramSize === 'None' && !/MBC2/.test(h.cartridgeType)) return <div className="svp"><small>{t('link.save.noBattery')}</small></div>;
    const known = d.profiles.find((x) => x.id === c.profile);
    const to = linked[p];
    const live = state.isRunning || !!wrote[p];
    return (
      <div className="svp">
        <label className="sel"><span>{t('link.save.label')}</span>
          <select value={c.slot !== null ? `slot:${c.slot}` : `p:${c.profile}`} disabled={state.isRunning} aria-describedby={`svp-s${p}`}
            aria-label={t('link.save.of', { p: String(p) })} onChange={(e) => pickSave(p, e.target.value)}>
            <optgroup label={t('link.save.games')}>
              {d.profiles.map((x) => <option key={x.id} value={`p:${x.id}`}>{x.name} · {ago(x.timestamp)} · {bytes(x.sram.length)}</option>)}
              {!known && c.slot === null && <option value={`p:${c.profile}`}>{t('link.save.newOf', { name: c.name })}</option>}
            </optgroup>
            <option value="new">{t('link.save.new')}</option>
            {d.states.some(Boolean) && (
              <optgroup label={t('link.save.fromState')}>
                {d.states.map((st, i) => st && <option key={i} value={i ? `slot:${i - 1}` : 'slot:auto'}>{i ? t('link.save.slot', { n: String(i) }) : t('game.resumePoint')} · {ago(st.timestamp)}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        {!state.isRunning && <button className="btn line svp-imp" aria-label={t('link.save.importFor', { p: String(p) })} onClick={() => savInput.current[p]?.click()}>{I.load}{t('game.saves.import')}</button>}
        <small id={`svp-s${p}`} aria-live="polite">
          {rich(live && to ? t(wrote[p] ? 'link.save.savingAgo' : 'link.save.saving', { ago: ago(wrote[p]) })
            : c.slot !== null ? t(known ? 'link.save.startsFrom' : 'link.save.startsFromNew', { slot: slotLabel(c.slot) })
            : known ? t('link.save.continues')
            : t('link.save.fresh'), { b: <b>{live && to ? nameOf(to) : known && c.slot === null ? known.name : c.slot !== null ? nameOf(c) : c.name}</b> })}
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
        <h2 id={`h-p${p}`}><i style={{ background: p === 1 ? 'var(--c)' : 'var(--m)' }} />{t('link.player', { p: String(p) })}</h2>
        <div className="ctl">{LEGEND[p].replace('{arrows}', t('link.arrows'))}</div>
        <div className="frame">
          <canvas ref={p === 1 ? link.p1CanvasRef : link.p2CanvasRef} className="lcd" width={160} height={144} aria-label={t('link.screen', { p: String(p) })} />
        </div>
        {cart(p, f)}
        {saveChooser(p)}
        <input ref={(el) => { fileInput.current[p] = el; }} type="file" accept={fileAccept('.gb,.gbc,.rom,.bin,.zip')} className="sr" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setFiles((s) => ({ ...s, [p]: file })); setPick((s) => ({ ...s, [p]: FILE })); }} />
      </section>
    );
  };

  return (
    <main className="wrap">
      <div className="pagehead">
        <h1>{t('link.title')}</h1>
        <p>{t('link.intro')}</p>
        <div className="acts" style={{ marginTop: 20 }}><Link className="btn y" to="/link-cable/online">{I.link}{t('online.entry')}</Link></div>
      </div>
      <div className="lc">
        {panel(1)}
        <div className={`cable${state.isRunning ? ' on' : ''}`} aria-live="polite"><i /><span>{state.isRunning ? t('link.state.linked') : ready ? t('link.state.idle') : t('link.state.starting')}</span><i /></div>
        {panel(2)}
      </div>
      {clash && !state.isRunning && (
        <div className="svp-warn" role="alert" style={{ marginTop: 16 }}>
          <p>{rich(t('link.clash'), { b: <b>{nameOf(choice[1]!)}</b> })}</p>
          <button className="btn p" onClick={copyForP2}>{t('link.copyP2')}</button>
        </div>
      )}
      {state.error && <p className="note" role="alert">{state.error.text}{state.error.detail && <><br /><small lang="en">{state.error.detail}</small></>}</p>}
      <div className="lc-bar">
        <div className="row" style={{ border: 0, padding: 0, gap: 14, color: 'var(--paper)' }}>
          <button className="switch" role="switch" aria-checked={same} aria-label={t('link.same')} disabled={state.isRunning} onClick={() => setSame(!same)} />
          {t('link.same')}
        </div>
        <div className="acts">
          <button className="btn y lg" disabled={!ready || loading || (!playable.length && !files[1]) || (clash && !state.isRunning)} onClick={connect}>
            {state.isRunning ? <>{I.close}{t('link.disconnect')}</> : <>{I.link}{t('link.connect')}</>}
          </button>
        </div>
      </div>
      <CartridgePicker open={picking !== null} player={picking ?? 1} games={playable} current={picking ? sel[picking] : undefined}
        onPick={(id) => picking && choose(picking, id)} onFile={() => picking && choose(picking, FILE)} onClose={() => setPicking(null)} />
      <section className="sec compat" aria-labelledby="h-compat">
        <div className="sec-h"><h2 id="h-compat">{t('link.compat')}</h2><span className="count">{t('link.compatSub')}</span></div>
        {linkReady.length
          ? <div className="shelf">{linkReady.map((g) => <Item key={g.id} game={g} saved={savedIds} />)}</div>
          : <p className="shelf-empty">{t('link.compatNone')}</p>}
      </section>
    </main>
  );
}
