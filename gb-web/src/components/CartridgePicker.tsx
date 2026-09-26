import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { byline, linkReady, score, sortTitle } from '../lib/ui';
import type { GameEntry } from '../types/game';
import { I } from './icons';
import { Cover } from './library/Cover';
import { Hl } from './shell/SearchDialog';

type Chip = 'all' | 'link' | 'gb' | 'gbc';
const CHIPS: [Chip, string][] = [['all', 'All'], ['link', 'Link-ready'], ['gb', 'Game Boy'], ['gbc', 'Game Boy Color']];
const KEEP: Record<Chip, (g: GameEntry) => boolean> = { all: () => true, link: linkReady, gb: (g) => g.platform === 'gb', gbc: (g) => g.platform === 'gbc' };
const RECENT = 5;
// Fixed heights let the list render only the rows in view (300+ games stay instant).
const ROW = 64, HEAD = 36, OVERSCAN = 6;

type Entry = { h: string } | { g: GameEntry; key: string };
const isRow = (e: Entry): e is { g: GameEntry; key: string } => 'g' in e;

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

  const q = query.trim().toLowerCase();
  const entries = useMemo<Entry[]>(() => {
    const pool = games.filter(KEEP[chip]);
    const rows = (s: string, gs: GameEntry[]): Entry[] => (gs.length ? [{ h: `${s} · ${gs.length}` }, ...gs.map((g) => ({ g, key: `${s}:${g.id}` }))] : []);
    if (q) {
      const hits = pool.map((g) => [g, score(g, q)] as const).filter(([, n]) => n > 0)
        .sort(([a, x], [b, y]) => y - x || sortTitle(a.title).localeCompare(sortTitle(b.title))).map(([g]) => g);
      return rows('Results', hits);
    }
    const az = [...pool].sort((a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title)));
    return [
      ...(chip === 'link' ? [] : rows('Link-ready', az.filter(linkReady))),
      ...rows('Recently played', pool.filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed! - a.lastPlayed!).slice(0, RECENT)),
      ...rows('All games A–Z', az),
    ];
  }, [games, chip, q]);
  const tops = useMemo(() => { let y = 0; return entries.map((e) => { const t = y; y += isRow(e) ? ROW : HEAD; return t; }).concat(y); }, [entries]);
  const rowIdx = useMemo(() => entries.flatMap((e, i) => (isRow(e) ? [i] : [])), [entries]);
  const sel = rowIdx.length ? rowIdx[Math.min(active, rowIdx.length - 1)] : -1;
  const selEntry = sel >= 0 ? entries[sel] as { g: GameEntry; key: string } : null;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      back.current = document.activeElement as HTMLElement | null;
      d.showModal();
      // Start on the cartridge already in the slot (its "All games" row), else the first row.
      let i = rowIdx.length;
      while (i-- > 0 && (entries[rowIdx[i]] as { g: GameEntry }).g.id !== current);
      setActive(Math.max(0, i));
      input.current?.focus();
      reveal(Math.max(0, i), true);
    }
    if (!open && d.open) d.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open/close
  }, [open]);

  const measure = () => { const l = list.current; if (l) setView({ top: l.scrollTop, h: l.clientHeight }); };
  useEffect(() => { if (!open) return; addEventListener('resize', measure); return () => removeEventListener('resize', measure); }, [open]);

  /** Scroll the list so row `n` (an index into the rows) shows, with its section heading when it is the first. */
  const reveal = (n: number, center = false) => {
    const l = list.current, i = rowIdx[n];
    if (!l || i === undefined) return;
    const top = tops[i] - (i > 0 && !isRow(entries[i - 1]) ? HEAD : 0), bottom = tops[i] + ROW;
    if (center) l.scrollTop = top - l.clientHeight / 2 + ROW;
    else if (top < l.scrollTop) l.scrollTop = top;
    else if (bottom > l.scrollTop + l.clientHeight) l.scrollTop = bottom - l.clientHeight;
    measure(); // render the new window now, not a frame later on the scroll event
  };
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

  return (
    <dialog ref={ref} className="mdlg pick" aria-labelledby="pick-t" onKeyDown={onKey}
      onClose={() => { setQuery(''); setChip('all'); onClose(); back.current?.focus(); }}
      onClick={(e) => { if (e.target === ref.current) ref.current.close(); }}>
      {open && (
        <>
          <span className="bar" aria-hidden="true"><i /><i /><i /></span>
          <div className="pk-head">
            <h2 id="pick-t">Player {player} cartridge</h2>
            <button className="pk-x" aria-label="Close" onClick={() => ref.current?.close()}>{I.close}</button>
          </div>
          <div className="pk-q">
            <input ref={input} type="search" placeholder="Title, developer or year" autoComplete="off" spellCheck={false}
              role="combobox" aria-expanded="true" aria-controls="pk-list" aria-autocomplete="list" aria-label="Search cartridges"
              aria-activedescendant={selEntry ? `pk-${selEntry.key}` : undefined}
              value={query} onChange={(e) => { setQuery(e.target.value); reset(); }} />
          </div>
          <div className="pk-chips" role="group" aria-label="Filter">
            {CHIPS.map(([k, label]) => (
              <button key={k} className="pk-chip" aria-pressed={chip === k} onClick={() => { setChip(k); reset(); }}>{label}</button>
            ))}
          </div>
          <div ref={list} className="pk-list" id="pk-list" role="listbox" aria-label="Cartridges" onScroll={measure}>
            {rowIdx.length ? (
              <div style={{ height: tops[entries.length], position: 'relative' }}>
                {entries.slice(first, last).map((e, k) => {
                  const i = first + k, top = tops[i];
                  if (!isRow(e)) return <div key={e.h} className="pk-h" role="presentation" style={{ top }}>{e.h}</div>;
                  const g = e.g, sub = byline(g);
                  return (
                    <div key={e.key} id={`pk-${e.key}`} className="pk-row" role="option" aria-selected={i === sel} style={{ top }}
                      onPointerDown={(ev) => ev.preventDefault()} onClick={() => pick(g)} onMouseMove={() => i !== sel && setActive(rowIdx.indexOf(i))}>
                      <Cover game={g} />
                      <span className="t"><Hl text={g.title} q={q} />{sub && <small><Hl text={sub} q={q} /></small>}</span>
                      <span className="pk-tags">
                        {linkReady(g) && <span className="tag now" title="Two players over the link cable">{I.link}<span className="sr">Link-ready</span></span>}
                        {g.platform && <span className="tag rom">{g.platform === 'gbc' ? 'GBC' : 'GB'}</span>}
                        {g.id === current && <span className="pk-cur">In slot</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="pk-empty">
                {q ? <>No cartridge matches “{query.trim()}”.</> : <>No {CHIPS.find(([k]) => k === chip)![1]} cartridges in your library.</>}
                <small>Try a developer or a year, pick another filter, or load the ROM file below.</small>
              </p>
            )}
          </div>
          <button className="pk-file" onClick={() => { ref.current?.close(); onFile(); }}>
            {I.load}<span>Load a file…<small>A .gb or .gbc ROM that isn’t in your library</small></span>
          </button>
        </>
      )}
    </dialog>
  );
}
