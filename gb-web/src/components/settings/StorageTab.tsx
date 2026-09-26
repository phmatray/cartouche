import { useCallback, useEffect, useRef, useState } from 'react';
import { clearAll, getAllFrom, STORES, type StoredRom, type StoredSave, type StoredSaveState, type StoredScreenshot } from '../../lib/db';
import { backupFileName, exportBackup, readBackup, restoreBackup } from '../../lib/backup';
import { refreshSavedIds, reloadLibrary, useGameLibrary } from '../../hooks/useGameLibrary';
import { useSettingsStore } from '../../store/settingsStore';
import { toast } from '../shell/actions';
import { ConfirmDialog, type ConfirmRequest } from '../shell/ConfirmDialog';
import { askBoxArt, boxArtBytes, deleteBoxArt, fetchBoxArtFor, useBoxArtProgress } from '../../lib/cover-art';
import { Row, SwitchRow } from './parts';

interface Usage { roms: number; saves: number; shots: number; perGame: Map<string, { rom: number; saves: number }>; nSaves: number; nShots: number }
const mb = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(n ? 1 : 0, Math.round(n / 1024))} KB`);
const gameOf = (stateId: string) => stateId.replace(/-(slot-\d+|auto)$/, '');

async function measure(): Promise<Usage> {
  const [roms, sram, states, shots] = await Promise.all([
    getAllFrom<StoredRom>(STORES.roms), getAllFrom<StoredSave>(STORES.saves),
    getAllFrom<StoredSaveState>(STORES.states), getAllFrom<StoredScreenshot>(STORES.screenshots),
  ]);
  const perGame = new Map(roms.map((r) => [r.id, { rom: r.data.length, saves: 0 }]));
  let saves = 0;
  for (const s of sram) { saves += s.sram.length; const g = perGame.get(s.id); if (g) g.saves++; }
  for (const s of states) { saves += s.data.length + s.thumbnail.length; const g = perGame.get(gameOf(s.id)); if (g) g.saves++; }
  return {
    roms: roms.reduce((a, r) => a + r.data.length, 0), saves, shots: shots.reduce((a, s) => a + s.png.size, 0),
    perGame, nSaves: sram.length + states.length, nShots: shots.length,
  };
}

export function StorageTab() {
  const { games, deleteGame } = useGameLibrary();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const withSettings = useRef(false);
  const { showBoxArt, boxArtAnswer, setShowBoxArt } = useSettingsStore();
  const artProgress = useBoxArtProgress();
  const [artBytes, setArtBytes] = useState(0);
  // Measured again when a download ends or box art is switched.
  useEffect(() => { boxArtBytes().then(setArtBytes); }, [artProgress.of, showBoxArt]);

  const refresh = useCallback(async () => {
    setUsage(await measure());
    const e = await navigator.storage?.estimate?.();
    if (e) setQuota({ usage: e.usage ?? 0, quota: e.quota ?? 0 });
  }, []);
  useEffect(() => {
    let live = true;
    measure().then((u) => live && setUsage(u));
    navigator.storage?.estimate?.().then((e) => live && setQuota({ usage: e.usage ?? 0, quota: e.quota ?? 0 }));
    navigator.storage?.persisted?.().then((p) => live && setPersisted(p));
    return () => { live = false; };
  }, []);

  const own = games.filter((g) => g.isLocal).sort((a, b) => a.title.localeCompare(b.title));
  const recognized = own.filter((g) => g.libretroName);
  // Turning box art on asks first, unless the player already said yes.
  const switchArt = (on: boolean) => (!on || boxArtAnswer?.consent ? setShowBoxArt(on) : askBoxArt());
  const downloadArt = async () => {
    if (!boxArtAnswer?.consent) return askBoxArt(); // a yes there downloads the whole library
    setShowBoxArt(true);
    await fetchBoxArtFor(recognized);
    toast('Box art downloaded', 'c');
  };
  const removeArt = async () => {
    await deleteBoxArt();
    setArtBytes(await boxArtBytes());
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
  const remove = (id: string, title: string) => setConfirm({
    title: 'Remove this ROM?', danger: true, ok: 'Remove',
    body: `${title} and its save slots, resume point and screenshots will be deleted from this browser.`,
    run: async () => { await deleteGame(id); await refresh(); toast(`${title} removed`, 'm'); },
  });
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
        <span><i style={{ background: 'var(--ink)' }} />ROMs · {own.length} · {mb(usage?.roms ?? 0)}</span>
        <span><i style={{ background: 'var(--m)' }} />Saves · {usage?.nSaves ?? 0} · {mb(usage?.saves ?? 0)}</span>
        <span><i style={{ background: 'var(--c)' }} />Screenshots · {usage?.nShots ?? 0} · {mb(usage?.shots ?? 0)}</span>
        {quota && <span>{mb(quota.usage)} used by this site, of about {mb(quota.quota)} this browser allows (estimate)</span>}
      </div>
      <Row label="Protect my data from automatic cleanup"
        sub={persisted ? 'Granted: the browser won’t evict your library when space runs low.' : 'Asks the browser not to evict your library when space runs low.'}>
        <button className={`btn ${persisted ? 'line' : 'k'}`} style={persisted ? { color: 'var(--ink)' } : undefined} disabled={persisted} onClick={persist}>{persisted ? 'Protected' : 'Protect'}</button>
      </Row>

      <h3>Box art</h3>
      <SwitchRow label="Show box art"
        sub="Off by default. Covers of recognized games you added, downloaded by your browser from the libretro-thumbnails project on GitHub (which sees your IP address and browser details) and kept in this browser. Cartouche hosts none. Off: no request is made."
        on={showBoxArt && !!boxArtAnswer?.consent} set={switchArt} />
      <Row label="Downloaded box art" sub={`${mb(artBytes)} stored in this browser`}>
        <button className="btn danger" disabled={!artBytes && !showBoxArt} onClick={removeArt}>Delete downloaded box art</button>
      </Row>
      <Row label="Download box art for my library now"
        sub={artProgress.of ? `Fetching box art · ${artProgress.n} of ${artProgress.of}` : `${recognized.length} recognized game${recognized.length === 1 ? '' : 's'} in your library`}>
        <button className="btn line" style={{ color: 'var(--ink)' }} disabled={!recognized.length || artProgress.of > 0} onClick={downloadArt}>Download</button>
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
      {own.length ? (
        <table className="gtable">
          <thead><tr><th>Game</th><th>ROM</th><th>Saves</th><th><span className="sr">Actions</span></th></tr></thead>
          <tbody>
            {own.map((g) => {
              const u = usage?.perGame.get(g.id);
              return (
                <tr key={g.id}>
                  <td className="t">{g.title}</td><td>{u ? mb(u.rom) : '—'}</td><td>{u?.saves ?? 0}</td>
                  <td><button className="sbtn" aria-label={`Remove ${g.title}`} onClick={() => remove(g.id, g.title)}>Remove</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <p className="empty-inline">No ROMs stored yet.</p>}

      <h3>Start over</h3>
      <Row label="Erase everything" sub="Removes every ROM, save, screenshot and setting from this browser">
        <button className="btn danger" onClick={wipe}>Erase everything</button>
      </Row>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
