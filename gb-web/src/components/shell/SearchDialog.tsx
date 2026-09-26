import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useGameLibrary } from '../../hooks/useGameLibrary';
import { byline, folded, owned, paths, score, searchKey, sortTitle, tagOf } from '../../lib/ui';
import { I } from '../icons';
import { Cover } from '../library/Cover';

const MAX_RESULTS = 60;

/** `text` with the first match of each query word (from `searchKey`) marked, accents and punctuation ignored. */
export function Hl({ text, q }: { text: string; q: string }): ReactNode {
  const { s, at } = folded(text);
  const on = new Array<boolean>(text.length).fill(false);
  for (const w of q.split(' ')) {
    const i = w ? s.indexOf(w) : -1;
    if (i >= 0) on.fill(true, at[i], at[i + w.length - 1] + 1);
  }
  const out: ReactNode[] = [];
  for (let i = 0; i < text.length;) {
    let j = i;
    while (j < text.length && on[j] === on[i]) j++;
    out.push(on[i] ? <mark key={i}>{text.slice(i, j)}</mark> : text.slice(i, j));
    i = j;
  }
  return out;
}

/** Full-screen search over the whole library ("/" opens it). */
export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { games, savedIds } = useGameLibrary();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const q = searchKey(query);
  const results = useMemo(() => q
    ? games.map((g) => [g, score(g, q)] as const).filter(([, n]) => n > 0)
      .sort(([a, x], [b, y]) => y - x || sortTitle(a.title).localeCompare(sortTitle(b.title))).map(([g]) => g)
    : games.filter((g) => owned(g) && (g.lastPlayed || g.importedAt)).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0)),
  [games, q]);
  const shown = results.slice(0, MAX_RESULTS);
  const sel = Math.min(idx, Math.max(0, shown.length - 1));

  const close = () => { setQuery(''); setIdx(0); onClose(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; } // one Esc closes, even with text in the field
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      const next = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      setIdx(next);
      ref.current?.querySelectorAll('[role=option]')[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && shown[sel]) {
      e.preventDefault();
      navigate(paths.game(shown[sel].id));
      close();
    }
  };

  return (
    <dialog ref={ref} className="sdlg" aria-label="Search games" onClose={close} onKeyDown={onKey}>
      {open && (
        <div className="wrap">
          <div className="sbar">
            <svg className="icon" style={{ width: 36, height: 36 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
            <input type="search" placeholder="Search games" autoComplete="off" autoFocus aria-controls="sres"
              value={query} onChange={(e) => { setQuery(e.target.value); setIdx(0); }} />
            <button className="close" aria-label="Close search" onClick={close}>{I.close}</button>
          </div>
          <div className="shint">
            <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span>
            <span>{q ? `${results.length.toLocaleString('en-US')} result${results.length === 1 ? '' : 's'}${results.length > MAX_RESULTS ? `, first ${MAX_RESULTS} shown` : ''}` : 'Recently played'}</span>
          </div>
          <ul className="sres" id="sres" role="listbox">
            {shown.length ? shown.map((g, i) => {
              const [kind, label] = tagOf(g, savedIds);
              return (
                <li key={g.id}>
                  <Link to={paths.game(g.id)} role="option" aria-selected={i === sel} onClick={close}>
                    <Cover game={g} aria-hidden />
                    <span className="t"><Hl text={g.title} q={q} /><small>{[byline(g), g.genre !== 'Unknown' ? g.genre : ''].filter(Boolean).join(' · ')}</small></span>
                    <span className={`tag ${kind}`} style={{ margin: 0 }}>{label}</span>
                  </Link>
                </li>
              );
            }) : (
              <li className="sempty">{q ? <>No game called “{query.trim()}”. Add it from your own files with Add ROMs.</> : 'Games you play show up here.'}</li>
            )}
          </ul>
        </div>
      )}
    </dialog>
  );
}
