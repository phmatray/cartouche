import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { deleteSave, getGameSaveStates, getScreenshots, listProfiles, putInto, deleteScreenshot, STORES, type StoredSave, type StoredSaveState, type StoredScreenshot } from '../../lib/db';
import { refreshSavedIds, titleKey, useGameLibrary } from '../../hooks/useGameLibrary';
import { forgetBoxArt } from '../../lib/cover-art';
import { ago, mb, paths, sortTitle } from '../../lib/ui';
import type { GameEntry } from '../../types/game';
import { I } from '../icons';
import { Shot } from '../game/Shot';
import { toast } from '../shell/actions';
import type { ConfirmRequest } from '../shell/ConfirmDialog';
import { date, list as listOf, num, rich, t as tNow, useT } from '../../i18n';

/** What one game keeps in this browser, in bytes (art: downloaded box art; bundled covers ship with the app). */
export interface GameUsage { rom: number; saves: number; nSaves: number; shots: number; nShots: number; art: number }
const totalOf = (u: GameUsage) => u.rom + u.saves + u.shots + u.art;

type Sort = 'size' | 'name' | 'played';
interface Line { game: GameEntry; u: GameUsage; total: number }

const ROW = 60; // px, every row (the one open row adds its detail below it)
const OVERSCAN = 6;

/**
 * Settings › Storage › Per game: a summary, then every game with something stored, searchable,
 * sortable and filterable, in a windowed list (only the rows on screen are in the DOM, so 300 or
 * 3,000 cartridges scroll the same). Rows can be selected and deleted together after a confirmation.
 */
export function PerGame({ usage, onChanged, confirm }: { usage: Map<string, GameUsage> | null; onChanged: () => Promise<void>; confirm: (r: ConfirmRequest) => void }) {
  const { games, removeGames } = useGameLibrary();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('size');
  const [withSaves, setWithSaves] = useState(false);
  const [never, setNever] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const none = useRef<HTMLParagraphElement>(null);
  const t = useT();
  // After a delete the removed rows (or the now disabled "Delete selected") took focus with them:
  // once the list has re-rendered, land on the search field, or on "No ROMs…" when nothing is left.
  const [refocus, setRefocus] = useState(0);
  useEffect(() => { if (refocus) (search.current ?? none.current)?.focus(); }, [refocus]);

  const all = useMemo<Line[]>(() => {
    if (!usage) return [];
    return games.filter((g) => usage.has(g.id)).map((g) => { const u = usage.get(g.id)!; return { game: g, u, total: totalOf(u) }; });
  }, [games, usage]);

  const rows = useMemo(() => {
    const k = titleKey(q);
    const byName = (a: Line, b: Line) => sortTitle(a.game.title).localeCompare(sortTitle(b.game.title));
    const cmp: Record<Sort, (a: Line, b: Line) => number> = {
      size: (a, b) => b.total - a.total || byName(a, b),
      name: byName,
      played: (a, b) => (b.game.lastPlayed || 0) - (a.game.lastPlayed || 0) || byName(a, b),
    };
    return all.filter((l) => (!k || titleKey(l.game.title).includes(k)) && (!withSaves || l.u.nSaves > 0) && (!never || !l.game.lastPlayed)).sort(cmp[sort]);
  }, [all, q, sort, withSaves, never]);

  const sum = useMemo(() => all.reduce((s, l) => ({ rom: s.rom + l.u.rom, saves: s.saves + l.u.saves, shots: s.shots + l.u.shots, art: s.art + l.u.art }), { rom: 0, saves: 0, shots: 0, art: 0 }), [all]);
  const top = useMemo(() => [...all].sort((a, b) => b.total - a.total).slice(0, 5), [all]);
  // Only what is still listed can be selected (a deleted or filtered-out game drops out of the selection count).
  const chosen = rows.filter((l) => picked.has(l.game.id));
  const allShown = rows.length > 0 && chosen.length === rows.length;

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pickAll = () => setPicked(allShown ? new Set() : new Set(rows.map((l) => l.game.id)));

  const del = (list: Line[]) => {
    if (!list.length) return;
    const roms = list.filter((l) => l.game.isLocal);
    const freed = list.reduce((s, l) => s + (l.game.isLocal ? l.total : l.u.saves + l.u.shots + l.u.art), 0);
    const nSaves = list.reduce((s, l) => s + l.u.nSaves, 0), nShots = list.reduce((s, l) => s + l.u.nShots, 0);
    const art = list.reduce((s, l) => s + l.u.art, 0), nArt = list.filter((l) => l.u.art > 0).length;
    const kept = list.length - roms.length;
    const names = listOf([...list.slice(0, 6).map((l) => l.game.title), ...(list.length > 6 ? [t('settings.pergame.more', { count: list.length - 6 })] : [])]);
    const parts = [
      ...(roms.length ? [t('settings.pergame.roms', { count: roms.length, size: mb(roms.reduce((s, l) => s + l.u.rom, 0)) })] : []),
      t('settings.pergame.saves', { count: nSaves }), t('settings.storage.nShots', { count: nShots }),
      ...(nArt ? [t('settings.pergame.covers', { count: nArt, size: mb(art) })] : []),
    ];
    confirm({
      title: t('settings.pergame.deleteTitle', { count: list.length }), danger: true, ok: t('settings.pergame.deleteOk', { size: mb(freed) }),
      body: (
        <>
          {t('settings.pergame.from', { names, parts: listOf(parts) })}
          {kept ? ` ${t('settings.pergame.kept', { count: kept })}` : ''}
          {' '}{rich(t('settings.pergame.frees', { size: mb(freed) }), { b: (s) => <b>{s}</b> })}
        </>
      ),
      run: async () => {
        await Promise.all([removeGames(list.map((l) => l.game)), ...list.map((l) => forgetBoxArt(l.game))]);
        setPicked(new Set());
        if (list.some((l) => l.game.id === open)) setOpen(null);
        await onChanged();
        await refreshSavedIds();
        toast(tNow('settings.pergame.deleted', { games: tNow('common.games', { count: list.length }), size: mb(freed) }), 'm');
        setRefocus((n) => n + 1);
      },
    });
  };

  if (!usage) return <p className="empty-inline">{t('settings.pergame.measuring')}</p>;
  if (!all.length) return <p className="empty-inline" ref={none} tabIndex={-1}>{t('settings.pergame.none')}</p>;

  return (
    <div className="pg">
      <dl className="pg-sum">
        <div><dt>{t('settings.pergame.games')}</dt><dd>{num(all.length)}</dd></div>
        <div><dt>{t('settings.pergame.romsCol')}</dt><dd>{mb(sum.rom)}</dd></div>
        <div><dt>{t('game.saves.title')}</dt><dd>{mb(sum.saves)}</dd></div>
        <div><dt>{t('settings.storage.shots')}</dt><dd>{mb(sum.shots)}</dd></div>
        <div><dt>{t('settings.storage.art')}</dt><dd>{mb(sum.art)}</dd></div>
      </dl>
      <p className="pg-top"><b>{t('settings.pergame.largest')}</b>{' '}
        {top.map((l, i) => <span key={l.game.id}>{i > 0 && ' · '}<button className="linkbtn" onClick={() => { setQ(''); setWithSaves(false); setNever(false); setOpen(l.game.id); setSort('size'); }}>{l.game.title}</button> {mb(l.total)}</span>)}
      </p>

      <div className="pg-tools">
        <input ref={search} className="field" type="search" placeholder={t('settings.pergame.search')} aria-label={t('settings.pergame.searchLabel')} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="sel">{t('library.sortLabel')}
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="size">{t('settings.pergame.bySize')}</option>
            <option value="name">{t('library.sort.name')}</option>
            <option value="played">{t('library.col.last')}</option>
          </select>
        </label>
        <div className="chips" role="group" aria-label={t('library.filterLabel')}>
          <button className="chip" aria-pressed={withSaves} onClick={() => setWithSaves(!withSaves)}>{t('settings.pergame.withSaves')}</button>
          <button className="chip" aria-pressed={never} onClick={() => setNever(!never)}>{t('search.value.is.unplayed')}</button>
        </div>
      </div>

      <div className="pg-bar">
        <label className="ck"><input type="checkbox" checked={allShown} ref={(el) => { if (el) el.indeterminate = chosen.length > 0 && !allShown; }} onChange={pickAll} /><span>{chosen.length ? t('settings.pergame.selected', { count: chosen.length }) : t('settings.pergame.selectAll', { count: rows.length })}</span></label>
        <button className="btn danger" disabled={!chosen.length} onClick={() => del(chosen)}>{t('settings.pergame.deleteSelected')}</button>
      </div>

      {rows.length
        ? <Rows rows={rows} picked={picked} toggle={toggle} open={open} setOpen={setOpen} onChanged={onChanged} remove={(l) => del([l])} confirm={confirm} />
        : <p className="empty-inline">{t('settings.pergame.noMatch')} <button className="linkbtn" onClick={() => { setQ(''); setWithSaves(false); setNever(false); }}>{t('settings.pergame.clear')}</button></p>}
    </div>
  );
}

/** The windowed list: rows are absolutely placed at i × ROW (plus the open row's detail height after it). */
function Rows({ rows, picked, toggle, open, setOpen, onChanged, remove, confirm }: {
  rows: Line[]; picked: Set<string>; toggle: (id: string) => void; open: string | null; setOpen: (id: string | null) => void;
  onChanged: () => Promise<void>; remove: (l: Line) => void; confirm: (r: ConfirmRequest) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [viewH, setViewH] = useState(540);
  const [detailH, setDetailH] = useState(0);
  const focusNext = useRef<string | null>(null);
  const t = useT();
  // Roving tabindex: only the current row's checkbox and name are Tab stops, and that row always stays
  // rendered (even scrolled out of the window) so focus on it is never dropped.
  const [cur, setCur] = useState<string | null>(null);
  const act = Math.max(0, rows.findIndex((l) => l.game.id === cur));
  const openIdx = rows.findIndex((l) => l.game.id === open);
  const extra = openIdx >= 0 ? detailH : 0;
  const topOf = (i: number) => i * ROW + (openIdx >= 0 && i > openIdx ? extra : 0);
  const indexAt = (y: number) => (openIdx < 0 || y < (openIdx + 1) * ROW ? Math.floor(y / ROW) : y < (openIdx + 1) * ROW + extra ? openIdx : Math.floor((y - extra) / ROW));
  const start = Math.max(0, indexAt(scroll) - OVERSCAN);
  const end = Math.min(rows.length, indexAt(scroll + viewH) + OVERSCAN + 1);
  const height = rows.length * ROW + extra;
  const shown = rows.slice(start, end).map((l, k) => [start + k, l] as const);
  if (act < start || act >= end) shown.push([act, rows[act]]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Arrow keys: the row asked for is rendered first (scrolled into the window), then focused.
  useEffect(() => {
    const sel = focusNext.current;
    if (sel === null) return;
    const b = box.current?.querySelector<HTMLElement>(sel);
    if (b) { focusNext.current = null; b.focus(); }
  });
  const rowOf = (t: HTMLElement) => Number(t.closest<HTMLElement>('[data-row]')?.dataset.row ?? NaN);
  const onFocus = (e: FocusEvent) => { const i = rowOf(e.target as HTMLElement); if (!Number.isNaN(i) && rows[i]) setCur(rows[i].game.id); };
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const kind = t.matches('.vname') ? 'n' : t.matches('.vline input') ? 'c' : null;
    const i = rowOf(t);
    if (!kind || Number.isNaN(i)) return;
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : -1;
    if (next < 0 || next >= rows.length) return;
    e.preventDefault();
    const el = box.current!;
    const y = topOf(next);
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW - el.clientHeight;
    setScroll(el.scrollTop);
    setCur(rows[next].game.id);
    focusNext.current = `[data-f="${kind}${next}"]`;
    el.querySelector<HTMLElement>(focusNext.current)?.focus();
  };

  return (
    <>
      <div className="vhead" aria-hidden="true"><span /><span>{t('game.game')}</span><span>ROM</span><span>{t('game.saves.title')}</span><span>{t('settings.storage.shots')}</span><span>{t('settings.storage.art')}</span><span>{t('settings.pergame.total')}</span></div>
      <div className="vlist" ref={box} onScroll={(e) => setScroll(e.currentTarget.scrollTop)} onKeyDown={onKey} onFocus={onFocus}>
        <div role="list" aria-label={t('settings.pergame.list')} style={{ height, position: 'relative' }}>
          {shown.map(([i, l]) => {
            const g = l.game, u = l.u, isOpen = g.id === open, tab = i === act ? 0 : -1;
            return (
              <div key={g.id} role="listitem" aria-setsize={rows.length} aria-posinset={i + 1} data-row={i} className={`vrow${isOpen ? ' open' : ''}`} style={{ top: topOf(i) }}>
                <div className="vline">
                  <label className="ck"><input type="checkbox" data-f={`c${i}`} tabIndex={tab} checked={picked.has(g.id)} onChange={() => toggle(g.id)} aria-label={t('settings.pergame.select', { title: g.title })} /></label>
                  <button className="vname" data-f={`n${i}`} tabIndex={tab} aria-expanded={isOpen} aria-controls={isOpen ? `pgd-${i}` : undefined} onClick={() => setOpen(isOpen ? null : g.id)}>
                    {I.next}
                    <span><b>{g.title}</b><small><span className="m">{g.isLocal ? mb(u.rom) : t('settings.pergame.bundled')} · {t('settings.pergame.saves', { count: u.nSaves })} · </span>{g.lastPlayed ? t('library.hero.playedAgo', { ago: ago(g.lastPlayed) }) : t('settings.pergame.unplayed')}</small></span>
                  </button>
                  <span className="n">{g.isLocal ? mb(u.rom) : t('settings.pergame.bundled')}</span>
                  <span className="n">{u.nSaves ? `${u.nSaves} · ${mb(u.saves)}` : '—'}</span>
                  <span className="n">{u.nShots ? `${u.nShots} · ${mb(u.shots)}` : '—'}</span>
                  <span className="n">{g.coverArt ? t('settings.pergame.included') : u.art ? mb(u.art) : '—'}</span>
                  <span className="n tot">{mb(l.total)}</span>
                </div>
                {isOpen && <Detail id={`pgd-${i}`} line={l} onSize={setDetailH} onChanged={onChanged} onRemove={() => remove(l)} confirm={confirm} />}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/** One game opened: its resume point, slots, save profiles (each deletable after a confirmation) and album (screenshots delete one by one, with undo). */
function Detail({ id, line, onSize, onChanged, onRemove, confirm }: { id: string; line: Line; onSize: (h: number) => void; onChanged: () => Promise<void>; onRemove: () => void; confirm: (r: ConfirmRequest) => void }) {
  const g = line.game;
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  const [data, setData] = useState<{ profiles: StoredSave[]; states: (StoredSaveState | undefined)[]; shots: StoredScreenshot[] } | null>(null);
  const fetchAll = (gid: string) => Promise.all([listProfiles(gid), getGameSaveStates(gid), getScreenshots(gid)]).then(([profiles, states, shots]) => ({ profiles, states, shots }));
  const load = async () => setData(await fetchAll(g.id));
  useEffect(() => {
    let live = true;
    fetchAll(g.id).then((d) => live && setData(d));
    return () => { live = false; };
  }, [g.id]);
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => onSize(el.offsetHeight));
    ro.observe(el);
    return () => { ro.disconnect(); onSize(0); };
  }, [onSize]);

  const dropShot = async (s: StoredScreenshot) => {
    await deleteScreenshot(s.id!);
    await load();
    await onChanged();
    toast(tNow('settings.pergame.shotDeleted'), 'm', { label: tNow('settings.pergame.undo'), run: async () => { await putInto(STORES.screenshots, s); await load(); await onChanged(); } });
  };
  const dropProfile = (p: StoredSave) => confirm({
    title: t('game.saves.deleteTitle', { name: p.name }), danger: true, ok: t('game.saves.deleteOk'),
    body: t('settings.pergame.deleteSaveBody', { title: g.title, size: mb(p.sram.length), ago: ago(p.timestamp) }),
    run: async () => { await deleteSave(p.id); await load(); await onChanged(); await refreshSavedIds(); toast(tNow('game.saves.deleted', { name: p.name }), 'm'); },
  });
  const when = (ts: number) => ago(ts);
  const [resume, ...slots] = data?.states ?? [];
  const size = (s: StoredSaveState) => mb(s.data.length + s.thumbnail.length);

  return (
    <div className="vdetail" id={id} ref={ref}>
      {!data ? <p>{t('common.loading')}</p> : (
        <>
          <dl className="spec">
            <div><dt>{t('game.resumePoint')}</dt><dd>{resume ? `${size(resume)} · ${when(resume.timestamp)}` : t('common.none')}</dd></div>
            {data.profiles.length ? data.profiles.map((p) => (
              <div key={p.id} className="vprofile">
                <dt>{t('link.save.label')} · {p.name}</dt>
                <dd>{mb(p.sram.length)} · {when(p.timestamp)}<button className="sbtn" aria-label={t('settings.pergame.deleteSave', { name: p.name })} onClick={() => dropProfile(p)}>{I.close}</button></dd>
              </div>
            )) : <div><dt>{t('settings.pergame.battery')}</dt><dd>{t('common.none')}</dd></div>}
            {slots.map((s, i) => <div key={i}><dt>{t('game.slot', { n: String(i + 1) })}</dt><dd>{s ? `${size(s)} · ${when(s.timestamp)}` : t('common.empty')}</dd></div>)}
          </dl>
          {data.shots.length > 0 && (
            <ul className="vshots" aria-label={t('settings.pergame.shotsOf', { title: g.title })}>
              {data.shots.map((s) => (
                <li key={s.id}>
                  <Shot png={s.png} label={`${g.title}, ${date(s.timestamp, STAMP)}`} />
                  <button className="sbtn" aria-label={t(s.kind === 'print' ? 'settings.pergame.deletePrint' : 'settings.pergame.deleteShot', { date: date(s.timestamp, STAMP) })} onClick={() => dropShot(s)}>{I.close}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="acts">
            <Link className="sbtn" to={paths.game(g.id)}>{t('settings.pergame.gamePage')}</Link>
            <button className="sbtn" onClick={onRemove}>{g.isLocal ? t('settings.pergame.removeHere') : t('settings.pergame.eraseIts')}</button>
          </div>
        </>
      )}
    </div>
  );
}

const STAMP: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'medium' };
