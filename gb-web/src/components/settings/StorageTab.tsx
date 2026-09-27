import { useCallback, useEffect, useRef, useState } from 'react';
import { gameOfSave, getAllFrom, getAllGameMeta, getGameMeta, getRom, getRomIds, setGameMeta, STORES, type StoredSave, type StoredSaveState, type StoredScreenshot } from '../../lib/db';
import { backupFileName, exportBackup, readBackup, restoreBackup } from '../../lib/backup';
import { refreshSavedIds, reloadLibrary, useGameLibrary } from '../../hooks/useGameLibrary';
import { useSettingsStore } from '../../store/settingsStore';
import { toast } from '../shell/actions';
import { ConfirmDialog, type ConfirmRequest } from '../shell/ConfirmDialog';
import { askBoxArt, boxArtBytes, boxArtPerGame, deleteBoxArt, fetchBoxArtFor, needsDownload, NO_COVERS, useBoxArtProgress } from '../../lib/cover-art';
import { mb, owned } from '../../lib/ui';
import { isInstalled, isIos, fileAccept } from '../../lib/pwa';
import type { GameEntry } from '../../types/game';
import { Row, SwitchRow } from './parts';
import { PerGame, type GameUsage } from './PerGame';
import { date, num, t as tNow, useT } from '../../i18n';
import { eraseEverything } from '../../lib/wipe';

interface Usage { roms: number; saves: number; shots: number; perGame: Map<string, GameUsage>; nSaves: number; nShots: number }
const gameOf = (stateId: string) => stateId.replace(/-(slot-\d+|auto)$/, '');

/** A ROM stored before summaries had a size: read it once (alone) and keep its size. */
async function romSize(id: string): Promise<number> {
  const n = (await getRom(id))?.data.length ?? 0;
  const m = await getGameMeta(id);
  if (m?.rom) await setGameMeta({ ...m, rom: { ...m.rom, size: n } }).catch(() => {});
  return n;
}

/** Everything stored, per game: ROMs, cartridge saves + save states, screenshots, downloaded box art. */
async function measure(games: GameEntry[]): Promise<Usage> {
  const [romIds, metas, sram, states, shots, art] = await Promise.all([
    getRomIds(), getAllGameMeta(), getAllFrom<StoredSave>(STORES.saves),
    getAllFrom<StoredSaveState>(STORES.states), getAllFrom<StoredScreenshot>(STORES.screenshots),
    boxArtPerGame(games),
  ]);
  const perGame = new Map<string, GameUsage>();
  const of = (id: string) => {
    let g = perGame.get(id);
    if (!g) perGame.set(id, (g = { rom: 0, saves: 0, nSaves: 0, shots: 0, nShots: 0, art: 0 }));
    return g;
  };
  // ROM sizes from their summaries: reading every ROM would hold the whole library in memory.
  const sizes = new Map(metas.map((m) => [m.id, m.rom?.size]));
  let romBytes = 0;
  for (const id of romIds) romBytes += of(id).rom = sizes.get(id) ?? await romSize(id);
  for (const s of sram) { const g = of(gameOfSave(s.id)); g.saves += s.sram.length; g.nSaves++; }
  for (const s of states) { const g = of(gameOf(s.id)); g.saves += s.data.length + s.thumbnail.length; g.nSaves++; }
  for (const s of shots) { const g = of(s.gameId); g.shots += s.png.size; g.nShots++; }
  // Box art only counts for games that have something else stored (it is listed with them).
  for (const [id, n] of art) if (perGame.has(id)) perGame.get(id)!.art = n;
  let saves = 0, nSaves = 0, shotBytes = 0;
  for (const g of perGame.values()) { saves += g.saves; nSaves += g.nSaves; shotBytes += g.shots; }
  return { roms: romBytes, saves, shots: shotBytes, perGame, nSaves, nShots: shots.length };
}

export function StorageTab() {
  const { games } = useGameLibrary();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const withSettings = useRef(false);
  const { showBoxArt, boxArtAnswer, setShowBoxArt, showTests, set: setSettings } = useSettingsStore();
  const artProgress = useBoxArtProgress();
  const [art, setArt] = useState<{ bytes: number; games: Set<string> }>({ bytes: 0, games: new Set() });
  const t = useT();

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
    toast(n ? tNow('shell.art.ready', { count: n }) : NO_COVERS(), 'c');
  };
  const removeArt = async () => {
    await deleteBoxArt();
    setArt({ bytes: await boxArtBytes(), games: new Set() });
    await refresh();
    toast(tNow('settings.storage.artDeleted'), 'm');
  };
  const total = usage ? usage.roms + usage.saves + usage.shots : 0;
  const pct = (n: number) => `${total ? (n / total) * 100 : 0}%`;

  const persist = async () => {
    const ok = !!(await navigator.storage?.persist?.().catch(() => false));
    setPersisted(ok);
    toast(ok ? tNow('settings.storage.protectedToast') : tNow('settings.storage.declined'), ok ? 'c' : 'm');
  };
  const doExport = async () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await exportBackup());
    a.download = backupFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(tNow('settings.storage.exported'), 'c');
  };
  const [reading, setReading] = useState(false); // a big backup takes seconds to scan
  const doImport = async (file: File) => {
    setReading(true);
    try {
      const b = await readBackup(file).finally(() => setReading(false));
      withSettings.current = false;
      setConfirm({
        title: tNow('settings.storage.restoreTitle'),
        body: (
          <>
            {tNow(b.exported ? 'settings.storage.restoreWhat' : 'settings.storage.restoreWhatNoDate', {
              roms: tNow('settings.storage.nRoms', { count: b.romCount }), saves: tNow('settings.storage.nSaves', { count: b.saves.length + b.states.length }),
              shots: tNow('settings.storage.nShots', { count: b.screenshots.length }), date: b.exported ? date(new Date(b.exported).getTime(), { day: 'numeric', month: 'long', year: 'numeric' }) : '',
            })}
            {' '}{tNow('settings.storage.restoreMerge')}
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14, fontWeight: 700 }}>
              <input type="checkbox" onChange={(e) => { withSettings.current = e.target.checked; }} /> {tNow('settings.storage.restoreSettings')}
            </label>
          </>
        ),
        ok: tNow('settings.storage.restore'),
        run: async () => {
          const n = { roms: 0, saves: 0, screenshots: 0 };
          const what = () => ({ roms: tNow('settings.storage.nRoms', { count: n.roms }), saves: tNow('settings.storage.nSaves', { count: n.saves }), shots: tNow('settings.storage.nShots', { count: n.screenshots }) });
          try {
            await restoreBackup(b, withSettings.current, n);
            toast(tNow('settings.storage.restored', what()), 'c');
          } catch (e) {
            // A full disk (or any storage error) midway: say what landed; running it again skips that.
            toast(tNow(e instanceof DOMException && e.name === 'QuotaExceededError' ? 'settings.storage.restoreFull' : 'settings.storage.restoreFailed', what()), 'm');
          } finally {
            await reloadLibrary();
            await refreshSavedIds().catch(() => {});
            await refresh().catch(() => {});
          }
        },
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : tNow('settings.storage.unreadable'), 'm');
    }
  };
  const wipe = () => setConfirm({
    title: t('settings.storage.wipeTitle'), danger: true, ok: t('settings.storage.wipe'),
    body: t('settings.storage.wipeBody'),
    run: async () => {
      await eraseEverything();
      location.assign(import.meta.env.BASE_URL); // start over from a clean load
    },
  });

  return (
    <>
      <h2>{t('settings.tabs.storage')}</h2>
      <p className="intro">{t('settings.storage.intro')}</p>
      <div className="usage" role="img" aria-label={t('settings.storage.usage', { roms: mb(usage?.roms ?? 0), saves: mb(usage?.saves ?? 0), shots: mb(usage?.shots ?? 0) })}>
        <i style={{ width: pct(usage?.roms ?? 0), background: 'var(--ink)' }} />
        <i style={{ width: pct(usage?.saves ?? 0), background: 'var(--m)' }} />
        <i style={{ width: pct(usage?.shots ?? 0), background: 'var(--c)' }} />
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--ink)' }} />{t('settings.pergame.romsCol')} · {num(own.length)} · {mb(usage?.roms ?? 0)}</span>
        <span><i style={{ background: 'var(--m)' }} />{t('game.saves.title')} · {num(usage?.nSaves ?? 0)} · {mb(usage?.saves ?? 0)}</span>
        <span><i style={{ background: 'var(--c)' }} />{t('settings.storage.shots')} · {num(usage?.nShots ?? 0)} · {mb(usage?.shots ?? 0)}</span>
        {quota && <span>{t('settings.storage.quota', { usage: mb(quota.usage), quota: mb(quota.quota) })}</span>}
      </div>
      <Row label={t('settings.storage.protectLabel')}
        sub={<>
          {persisted ? t('settings.storage.granted') : t('settings.storage.asks')}
          {isIos() && !isInstalled() && ` ${t('settings.storage.ios')}`}
        </>}>
        <button className={`btn ${persisted ? 'line' : 'k'}`} style={persisted ? { color: 'var(--ink)' } : undefined} disabled={persisted} onClick={persist}>{persisted ? t('settings.storage.protected') : t('settings.storage.protect')}</button>
      </Row>

      <h3>{t('settings.storage.library')}</h3>
      <SwitchRow label={t('settings.storage.showTests')} sub={t('settings.storage.showTestsSub')} on={showTests} set={(v) => setSettings({ showTests: v })} />

      <h3>{t('settings.storage.art')}</h3>
      <SwitchRow label={t('settings.storage.showArt')}
        sub={t('settings.storage.showArtSub')}
        on={showBoxArt && !!boxArtAnswer?.consent} set={switchArt} />
      <Row label={t('settings.storage.covers')} sub={artProgress.of
        ? <span className="artprog"><span className="progress" role="progressbar" aria-label={t('shell.fetchingArt')} aria-valuemin={0} aria-valuemax={artProgress.of} aria-valuenow={artProgress.n}><i style={{ width: `${(artProgress.n / artProgress.of) * 100}%` }} /></span>{t('shell.progress', { label: t('shell.fetchingArt'), n: artProgress.n, of: artProgress.of })}</span>
        : t('settings.storage.coversSub', { covered, total: shelf.length, size: mb(art.bytes) })}>
        <button className="btn danger" disabled={!art.bytes && !showBoxArt} onClick={() => setConfirm({ title: t('settings.storage.deleteArtTitle'), danger: true, ok: t('settings.storage.deleteArt'), body: t('settings.storage.deleteArtBody', { size: mb(art.bytes) }), run: removeArt })}>{t('settings.storage.deleteArt')}</button>
      </Row>
      <Row label={t('settings.storage.downloadLabel')}
        sub={recognized.length ? t('settings.storage.canGet', { count: recognized.length }) : NO_COVERS()}>
        <button className="btn line" style={{ color: 'var(--ink)' }} disabled={artProgress.of > 0} onClick={downloadArt}>{t('settings.storage.download')}</button>
      </Row>

      <h3>{t('settings.storage.backup')}</h3>
      <Row label={t('settings.storage.exportLabel')} sub={t('settings.storage.exportSub')}>
        <button className="btn k" onClick={doExport}>{t('settings.storage.export')}</button>
      </Row>
      <Row label={t('settings.storage.restoreLabel')} sub={t('settings.storage.restoreSub')}>
        <label className="btn line" style={{ color: 'var(--ink)', ...(reading && { opacity: 0.6, cursor: 'progress' }) }} tabIndex={0} aria-disabled={reading || undefined}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}>
          <span role="status">{t(reading ? 'settings.storage.reading' : 'settings.storage.import')}</span>
          <input type="file" accept={fileAccept('.cartouche,.cartshelf,application/json')} className="sr" tabIndex={-1} disabled={reading}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) doImport(f); }} />
        </label>
      </Row>

      <h3>{t('settings.storage.perGame')}</h3>
      <PerGame usage={usage?.perGame ?? null} onChanged={refresh} confirm={setConfirm} />

      <h3>{t('settings.storage.startOver')}</h3>
      <Row label={t('settings.storage.wipe')} sub={t('settings.storage.wipeSub')}>
        <button className="btn danger" onClick={wipe}>{t('settings.storage.wipe')}</button>
      </Row>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
