import { useCallback, useEffect, useRef, useState } from 'react';
import { clearAll, gameOfSave, getAllFrom, STORES, type StoredRom, type StoredSave, type StoredSaveState, type StoredScreenshot } from '../../lib/db';
import { backupFileName, exportBackup, readBackup, restoreBackup } from '../../lib/backup';
import { refreshSavedIds, reloadLibrary, useGameLibrary } from '../../hooks/useGameLibrary';
import { useSettingsStore } from '../../store/settingsStore';
import { toast } from '../shell/actions';
import { ConfirmDialog, type ConfirmRequest } from '../shell/ConfirmDialog';
import { askBoxArt, boxArtBytes, boxArtPerGame, deleteBoxArt, fetchBoxArtFor, needsDownload, NO_COVERS, useBoxArtProgress } from '../../lib/cover-art';
import { mb, owned } from '../../lib/ui';
import { isInstalled, isIos } from '../../lib/pwa';
import type { GameEntry } from '../../types/game';
import { Row, SwitchRow } from './parts';
import { PerGame, type GameUsage } from './PerGame';

interface Usage { roms: number; saves: number; shots: number; perGame: Map<string, GameUsage>; nSaves: number; nShots: number }
const gameOf = (stateId: string) => stateId.replace(/-(slot-\d+|auto)$/, '');

/** Everything stored, per game: ROMs, cartridge saves + save states, screenshots, downloaded box art. */
async function measure(games: GameEntry[]): Promise<Usage> {
  const [roms, sram, states, shots, art] = await Promise.all([
    getAllFrom<StoredRom>(STORES.roms), getAllFrom<StoredSave>(STORES.saves),
    getAllFrom<StoredSaveState>(STORES.states), getAllFrom<StoredScreenshot>(STORES.screenshots),
    boxArtPerGame(games),
  ]);
  const perGame = new Map<string, GameUsage>();
  const of = (id: string) => {
    let g = perGame.get(id);
    if (!g) perGame.set(id, (g = { rom: 0, saves: 0, nSaves: 0, shots: 0, nShots: 0, art: 0 }));
    return g;
  };
  for (const r of roms) of(r.id).rom = r.data.length;
  for (const s of sram) { const g = of(gameOfSave(s.id)); g.saves += s.sram.length; g.nSaves++; }
  for (const s of states) { const g = of(gameOf(s.id)); g.saves += s.data.length + s.thumbnail.length; g.nSaves++; }
  for (const s of shots) { const g = of(s.gameId); g.shots += s.png.size; g.nShots++; }
  // Box art only counts for games that have something else stored (it is listed with them).
  for (const [id, n] of art) if (perGame.has(id)) perGame.get(id)!.art = n;
  let saves = 0, nSaves = 0, shotBytes = 0;
  for (const g of perGame.values()) { saves += g.saves; nSaves += g.nSaves; shotBytes += g.shots; }
  return { roms: roms.reduce((a, r) => a + r.data.length, 0), saves, shots: shotBytes, perGame, nSaves, nShots: shots.length };
}

export function StorageTab() {
  const { games } = useGameLibrary();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const withSettings = useRef(false);
  const { showBoxArt, boxArtAnswer, setShowBoxArt } = useSettingsStore();
  const artProgress = useBoxArtProgress();
  const [art, setArt] = useState<{ bytes: number; games: Set<string> }>({ bytes: 0, games: new Set() });

  const own = games.filter((g) => g.isLocal);
  const recognized = own.filter(needsDownload);
  const shelf = games.filter(owned); // your ROMs and the bundled games: everything that can show a cover
  const gamesRef = useRef(games);
  useEffect(() => { gamesRef.current = games; });
  // Covers are measured again when a download ends, box art is switched, or the library changes.
  useEffect(() => {
    let live = true;
    Promise.all([boxArtBytes(), boxArtPerGame(games)]).then(([bytes, per]) => live && setArt({ bytes, games: new Set(per.keys()) }));
    return () => { live = false; };
  }, [artProgress.of, showBoxArt, games]);
  const covered = shelf.filter((g) => g.coverArt || art.games.has(g.id)).length;

  const refresh = useCallback(async () => {
    setUsage(await measure(gamesRef.current));
    const e = await navigator.storage?.estimate?.();
    if (e) setQuota({ usage: e.usage ?? 0, quota: e.quota ?? 0 });
  }, []);
  const loaded = games.length > 0;
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    measure(gamesRef.current).then((u) => live && setUsage(u));
    navigator.storage?.estimate?.().then((e) => live && setQuota({ usage: e.usage ?? 0, quota: e.quota ?? 0 }));
    navigator.storage?.persisted?.().then((p) => live && setPersisted(p));
    return () => { live = false; };
  }, [loaded, artProgress.of]);

  // Turning box art on asks first, unless the player already said yes.
  const switchArt = (on: boolean) => (!on || boxArtAnswer?.consent ? setShowBoxArt(on) : askBoxArt());
  const downloadArt = async () => {
    if (!boxArtAnswer?.consent) return askBoxArt(); // a yes there downloads the whole library (or says there is nothing to fetch)
    setShowBoxArt(true);
    const n = await fetchBoxArtFor(recognized);
    toast(n ? `Box art ready for ${n} game${n === 1 ? '' : 's'}` : NO_COVERS, 'c');
  };
  const removeArt = async () => {
    await deleteBoxArt();
    setArt({ bytes: await boxArtBytes(), games: new Set() });
    await refresh();
    toast('Downloaded box art deleted', 'm');
  };
  const total = usage ? usage.roms + usage.saves + usage.shots : 0;
  const pct = (n: number) => `${total ? (n / total) * 100 : 0}%`;

  const persist = async () => {
    const ok = !!(await navigator.storage?.persist?.().catch(() => false));
    setPersisted(ok);
    toast(ok ? 'Your library is protected from cleanup' : 'The browser declined. It often agrees once the app is installed or used more.', ok ? 'c' : 'm');
  };
  const doExport = async () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await exportBackup());
    a.download = backupFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Backup exported', 'c');
  };
  const doImport = async (file: File) => {
    try {
      const b = await readBackup(file);
      withSettings.current = false;
      setConfirm({
        title: 'Restore this backup?',
        body: (
          <>
            {b.roms.length} ROM{b.roms.length === 1 ? '' : 's'}, {b.saves.length + b.states.length} saves and {b.screenshots.length} screenshots
            {b.exported ? `, from ${new Date(b.exported).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}.
            {' '}They are merged into this library: nothing here is removed, and a save is only replaced by a newer one.
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14, fontWeight: 700 }}>
              <input type="checkbox" onChange={(e) => { withSettings.current = e.target.checked; }} /> Also use the backup’s settings
            </label>
          </>
        ),
        ok: 'Restore',
        run: async () => {
          const n = await restoreBackup(b, withSettings.current);
          await reloadLibrary();
          await refreshSavedIds();
          await refresh();
          toast(`Restored ${n.roms} ROM${n.roms === 1 ? '' : 's'}, ${n.saves} saves, ${n.screenshots} screenshots`, 'c');
        },
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That file couldn’t be read', 'm');
    }
  };
  const wipe = () => setConfirm({
    title: 'Erase everything?', danger: true, ok: 'Erase everything',
    body: 'Every ROM, save slot, resume point, screenshot and setting will be deleted from this browser. Export a backup first if you might want them back.',
    run: async () => {
      await clearAll();
      useSettingsStore.getState().resetToDefaults();
      // Box art too (the offline app shell stays: it holds no personal data).
      await deleteBoxArt();
      location.assign(import.meta.env.BASE_URL); // start over from a clean load
    },
  });

  return (
    <>
      <h2>Storage</h2>
      <p className="intro">Your library lives in this browser only. Clearing site data or switching browsers loses it, so keep a backup.</p>
      <div className="usage" role="img" aria-label={`ROMs ${mb(usage?.roms ?? 0)}, saves ${mb(usage?.saves ?? 0)}, screenshots ${mb(usage?.shots ?? 0)}`}>
        <i style={{ width: pct(usage?.roms ?? 0), background: 'var(--ink)' }} />
        <i style={{ width: pct(usage?.saves ?? 0), background: 'var(--m)' }} />
        <i style={{ width: pct(usage?.shots ?? 0), background: 'var(--c)' }} />
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--ink)' }} />ROMs · {own.length.toLocaleString('en-US')} · {mb(usage?.roms ?? 0)}</span>
        <span><i style={{ background: 'var(--m)' }} />Saves · {usage?.nSaves ?? 0} · {mb(usage?.saves ?? 0)}</span>
        <span><i style={{ background: 'var(--c)' }} />Screenshots · {usage?.nShots ?? 0} · {mb(usage?.shots ?? 0)}</span>
        {quota && <span>{mb(quota.usage)} used by this site, of about {mb(quota.quota)} this browser allows (estimate)</span>}
      </div>
      <Row label="Protect my data from automatic cleanup"
        sub={<>
          {persisted ? 'Granted: the browser won’t evict your library when space runs low.' : 'Asks the browser not to evict your library when space runs low.'}
          {isIos() && !isInstalled() && ' Safari can also delete a website’s data after 7 days of use without a visit. Add Cartouche to your Home Screen (Settings › About) to keep it: Home Screen apps aren’t subject to that.'}
        </>}>
        <button className={`btn ${persisted ? 'line' : 'k'}`} style={persisted ? { color: 'var(--ink)' } : undefined} disabled={persisted} onClick={persist}>{persisted ? 'Protected' : 'Protect'}</button>
      </Row>

      <h3>Box art</h3>
      <SwitchRow label="Show box art"
        sub="Off by default. Covers of recognized games you added, downloaded by your browser from the libretro-thumbnails project on GitHub (which sees your IP address and browser details) and kept in this browser. Cartouche hosts none of them. Off: no request is made. The bundled Tobu Tobu Girl games always show their own freely licensed covers, which come with the app."
        on={showBoxArt && !!boxArtAnswer?.consent} set={switchArt} />
      <Row label="Covers" sub={artProgress.of
        ? <span className="artprog"><span className="progress" role="progressbar" aria-label="Fetching box art" aria-valuemin={0} aria-valuemax={artProgress.of} aria-valuenow={artProgress.n}><i style={{ width: `${(artProgress.n / artProgress.of) * 100}%` }} /></span>Fetching box art · {artProgress.n} of {artProgress.of}</span>
        : `${covered} of ${shelf.length} games have covers · ${mb(art.bytes)} downloaded, kept in this browser`}>
        <button className="btn danger" disabled={!art.bytes && !showBoxArt} onClick={removeArt}>Delete downloaded box art</button>
      </Row>
      <Row label="Download box art for my library now"
        sub={recognized.length ? `${recognized.length.toLocaleString('en-US')} recognized game${recognized.length === 1 ? '' : 's'} you added can get a cover` : NO_COVERS}>
        <button className="btn line" style={{ color: 'var(--ink)' }} disabled={artProgress.of > 0} onClick={downloadArt}>Download</button>
      </Row>

      <h3>Backup</h3>
      <Row label="Export everything" sub="ROMs, saves, save states, screenshots, favorites, play time and settings in one .cartouche file">
        <button className="btn k" onClick={doExport}>Export backup</button>
      </Row>
      <Row label="Restore from a backup" sub="Merges into this library; nothing is overwritten without asking">
        <label className="btn line" style={{ color: 'var(--ink)' }} tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}>
          Import backup
          <input type="file" accept=".cartouche,.cartshelf,application/json" className="sr" tabIndex={-1}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) doImport(f); }} />
        </label>
      </Row>

      <h3>Per game</h3>
      <PerGame usage={usage?.perGame ?? null} onChanged={refresh} confirm={setConfirm} />

      <h3>Start over</h3>
      <Row label="Erase everything" sub="Removes every ROM, save, screenshot and setting from this browser">
        <button className="btn danger" onClick={wipe}>Erase everything</button>
      </Row>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
