import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { byline, linkReady, score, searchKey, sortTitle } from '../lib/ui';
import type { GameEntry } from '../types/game';
import { I } from './icons';
import { Cover } from './library/Cover';
import { Hl } from './shell/SearchDialog';
import { num, rich, useT, type Key } from '../i18n';

type Chip = 'all' | 'link' | 'gb' | 'gbc';
// [key, label, short label for narrow screens]
const CHIPS: [Chip, Key | string, string][] = [['all', 'library.filter.all', ''], ['link', 'link.ready', ''], ['gb', 'Game Boy', 'GB'], ['gbc', 'Game Boy Color', 'GBC']];
const KEEP: Record<Chip, (g: GameEntry) => boolean> = { all: () => true, link: linkReady, gb: (g) => g.platform === 'gb', gbc: (g) => g.platform === 'gbc' };
const RECENT = 5;
// Fixed heights let the list render only the rows in view (300+ games stay instant).
const ROW = 64, HEAD = 36, OVERSCAN = 6;

type Row = { g: GameEntry; key: string; s: string };
type Entry = { h: string } | Row;
const isRow = (e: Entry): e is Row => 'g' in e;

/**
 * The cartridge shelf of the link cable page: search, filters and sections over the whole library.
 * Focus stays in the search field (a combobox); arrows, Home/End, Page keys and Enter drive the list.
 */
export function CartridgePicker({ open, player, games, current, onPick, onFile, onClose }: {
  open: boolean; player: number; games: GameEntry[]; current?: string;
  onPick: (id: string) => void; onFile: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [active, setActive] = useState(0);
  const [view, setView] = useState({ top: 0, h: 600 });
  const t = useT();
  const chipLabel = (l: string) => (l.includes('.') ? t(l as Key) : l);

  const q = searchKey(query);
  const entries = useMemo<Entry[]>(() => {
    const pool = games.filter(KEEP[chip]);
    const rows = (s: string, gs: GameEntry[]): Entry[] => (gs.length ? [{ h: `${s} · ${num(gs.length)}` }, ...gs.map((g) => ({ g, key: `${s}:${g.id}`, s }))] : []);
    if (q) {
      const hits = pool.map((g) => [g, score(g, q)] as const).filter(([, n]) => n > 0)
        .sort(([a, x], [b, y]) => y - x || sortTitle(a.title).localeCompare(sortTitle(b.title))).map(([g]) => g);
      return rows(t('search.resultsLabel'), hits);
    }
    const az = [...pool].sort((a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title)));
    return [
      ...(chip === 'link' ? [] : rows(t('link.ready'), az.filter(linkReady))),
      ...rows(t('library.sort.recent'), pool.filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed! - a.lastPlayed!).slice(0, RECENT)),
      ...rows(t('link.pick.az'), az),
    ];
  }, [games, chip, q, t]);
  const tops = useMemo(() => { let y = 0; return entries.map((e) => { const t = y; y += isRow(e) ? ROW : HEAD; return t; }).concat(y); }, [entries]);
  const rowIdx = useMemo(() => entries.flatMap((e, i) => (isRow(e) ? [i] : [])), [entries]);
  const sel = rowIdx.length ? rowIdx[Math.min(active, rowIdx.length - 1)] : -1;
  const selEntry = sel >= 0 ? entries[sel] as Row : null;

  const measure = () => { const l = list.current; if (l) setView({ top: l.scrollTop, h: l.clientHeight }); };
  useEffect(() => { if (!open) return; addEventListener('resize', measure); return () => removeEventListener('resize', measure); }, [open]);

  /**
   * Scroll the list so row `n` (an index into the rows) shows, with its section heading when it is the first.
   * `open`: put the row's section heading at the top when the row fits below it, else center the row.
   */
  const reveal = (n: number, open = false) => {
    const l = list.current, i = rowIdx[n];
    if (!l || i === undefined) return;
    const top = tops[i] - (i > 0 && !isRow(entries[i - 1]) ? HEAD : 0), bottom = tops[i] + ROW;
    let h = i;
    while (h > 0 && isRow(entries[h])) h--;
    if (open) l.scrollTop = bottom - tops[h] <= l.clientHeight ? tops[h] : tops[i] - l.clientHeight / 2 + ROW / 2;
    else if (top < l.scrollTop) l.scrollTop = top;
    else if (bottom > l.scrollTop + l.clientHeight) l.scrollTop = bottom - l.clientHeight;
    measure(); // render the new window now, not a frame later on the scroll event
  };
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      back.current = document.activeElement as HTMLElement | null;
      d.showModal();
      // Start on the cartridge already in the slot (its first row: Link-ready, Recently played, then A–Z), else the first row.
      const i = Math.max(0, rowIdx.findIndex((r) => (entries[r] as Row).g.id === current));
      setActive(i);
      input.current?.focus();
      reveal(i, true);
    }
    if (!open && d.open) d.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open/close
  }, [open]);

  const move = (n: number) => {
    if (!rowIdx.length) return;
    const next = Math.max(0, Math.min(rowIdx.length - 1, n));
    setActive(next);
    reveal(next);
  };
  const reset = () => { setActive(0); if (list.current) list.current.scrollTop = 0; measure(); };
  const pick = (g: GameEntry) => { onPick(g.id); ref.current?.close(); };

  const onKey = (e: KeyboardEvent) => {
    const cur = Math.min(active, rowIdx.length - 1), page = Math.max(1, Math.floor(view.h / ROW) - 1);
    const to: Record<string, number> = { ArrowDown: cur + 1, ArrowUp: cur - 1, PageDown: cur + page, PageUp: cur - page, Home: 0, End: rowIdx.length - 1 };
    if (e.key in to && !e.shiftKey && !e.altKey) { e.preventDefault(); move(to[e.key]); return; }
    if (e.key === 'Enter' && e.target === input.current && selEntry) { e.preventDefault(); pick(selEntry.g); return; }
    if (e.key === 'Tab') { // keep Tab inside the sheet
      const f = [...ref.current!.querySelectorAll<HTMLElement>('input,button:not([disabled])')];
      const edge = e.shiftKey ? f[0] : f[f.length - 1];
      if (document.activeElement === edge) { e.preventDefault(); (e.shiftKey ? f[f.length - 1] : f[0]).focus(); }
      return;
    }
    // Type to search from anywhere in the sheet (a chip, the close button).
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.target !== input.current && e.key !== ' ') {
      e.preventDefault();
      setQuery((s) => s + e.key);
      reset();
      input.current?.focus();
    }
  };

  const first = Math.max(0, tops.findIndex((t) => t + ROW >= view.top) - OVERSCAN);
  let last = first;
  while (last < entries.length && tops[last] < view.top + view.h) last++;
  last = Math.min(entries.length, last + OVERSCAN);
  // The active row stays rendered even when scrolled away, so aria-activedescendant always points at a real option.
  const shown = Array.from({ length: last - first }, (_, k) => first + k);
  if (sel >= 0 && (sel < first || sel >= last)) shown.push(sel);

  return (
    <dialog ref={ref} className="mdlg pick" aria-labelledby="pick-t" onKeyDown={onKey}
      onClose={() => { setQuery(''); setChip('all'); onClose(); back.current?.focus(); }}
      onClick={(e) => { if (e.target === ref.current) ref.current.close(); }}>
      {open && (
        <>
          <span className="bar" aria-hidden="true"><i /><i /><i /></span>
          <div className="pk-head">
            <h2 id="pick-t">{t('link.pick.title', { p: String(player) })}</h2>
            <button className="pk-x" aria-label={t('common.close')} onClick={() => ref.current?.close()}>{I.close}</button>
          </div>
          <div className="pk-q">
            <input ref={input} type="search" placeholder={t('link.pick.placeholder')} autoComplete="off" spellCheck={false}
              role="combobox" aria-expanded="true" aria-controls="pk-list" aria-autocomplete="list" aria-label={t('link.pick.search')}
              aria-activedescendant={selEntry ? `pk-${selEntry.key}` : undefined}
              value={query} onChange={(e) => { setQuery(e.target.value); reset(); }} />
          </div>
          <div className="pk-chips" role="group" aria-label={t('library.filterLabel')}>
            {CHIPS.map(([k, label, short]) => (
              <button key={k} className="pk-chip" aria-pressed={chip === k} onClick={() => { setChip(k); reset(); }}>
                <span className="pk-l">{chipLabel(label)}</span><span className="pk-s">{short || chipLabel(label)}</span>
              </button>
            ))}
          </div>
          <div className="shint pk-hint" aria-hidden="true">
            <span>{rich(t('search.hint.move'), { keys: <><kbd>↑</kbd> <kbd>↓</kbd></> })}</span><span>{rich(t('link.pick.insert'), { keys: <kbd>Enter</kbd> })}</span><span>{rich(t('search.hint.close'), { keys: <kbd>Esc</kbd> })}</span>
            <span>{q ? t('search.results', { count: rowIdx.length }) : t('link.pick.count', { count: games.length })}</span>
          </div>
          <div ref={list} className="pk-list" id="pk-list" role="listbox" aria-label={t('link.pick.list')} tabIndex={-1} onScroll={measure}>
            {rowIdx.length ? (
              <div style={{ height: tops[entries.length], position: 'relative' }}>
                {shown.map((i) => {
                  const e = entries[i], top = tops[i];
                  if (!isRow(e)) return <div key={e.h} className="pk-h" aria-hidden="true" style={{ top }}>{e.h}</div>;
                  const g = e.g, sub = [byline(g), g.region].filter(Boolean).join(' · '), n = rowIdx.indexOf(i);
                  return (
                    <div key={e.key} id={`pk-${e.key}`} className="pk-row" role="option" aria-selected={i === sel} style={{ top }}
                      aria-setsize={rowIdx.length} aria-posinset={n + 1}
                      onPointerDown={(ev) => ev.preventDefault()} onClick={() => pick(g)} onMouseMove={() => i !== sel && setActive(n)}>
                      <Cover game={g} aria-hidden />
                      <span className="t"><Hl text={g.title} q={q} />{sub && <small><Hl text={sub} q={q} /></small>}</span>
                      {e.s !== t('search.resultsLabel') && <span className="sr">, {e.s}</span>}
                      <span className="pk-tags">
                        {linkReady(g) && <span className="tag now" title={t('link.pick.twoPlayers')}>{I.link}<span className="pk-tl" aria-hidden="true">{t('link.pick.link')}</span><span className="sr">{t('link.ready')}</span></span>}
                        {g.platform && <span className="tag rom">{g.platform === 'gbc' ? 'GBC' : 'GB'}</span>}
                        {g.id === current && <span className="pk-cur">{t('link.pick.inSlot')}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="pk-empty">
                {q ? t('link.pick.noMatch', { text: query.trim() }) : t('link.pick.noneOf', { filter: chipLabel(CHIPS.find(([k]) => k === chip)![1]) })}
                <small>{t('link.pick.try')}</small>
              </p>
            )}
          </div>
          <button className="pk-file" onClick={() => { ref.current?.close(); onFile(); }}>
            {I.load}<span>{t('link.pick.file')}<small>{t('link.pick.fileSub')}</small></span>
          </button>
        </>
      )}
    </dialog>
  );
}
