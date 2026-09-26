import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useGameLibrary, useSearchIndex } from '../../hooks/useGameLibrary';
import { byline, folded, owned, paths, searchKey, spatialNext, tagOf } from '../../lib/ui';
import { facetCounts, facetKey, facetLabel, formatQuery, normValue, parseQuery, search, suggest, valueLabel, withoutEach, type Filter, type Key, type Query } from '../../lib/search';
import { I } from '../icons';
import { Cover } from '../library/Cover';

const MAX_RESULTS = 60;
const MAX_VALUES = 60;
// The facet bar, in order; the year range lives in the Decade sheet.
const BAR: Key[] = ['is', 'genre', 'players', 'region', 'platform', 'decade', 'developer', 'publisher', 'language', 'save'];

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

const sameFilter = (a: Filter, b: Filter) => a.key === b.key && a.value === b.value && !!a.neg === !!b.neg;
const chipText = (x: Filter, labels: Map<string, string>) => `${x.neg ? 'Not ' : x.key === 'is' ? '' : `${facetLabel(x.key)}: `}${valueLabel(x.key, x.value, labels)}`;
/** The token being typed at the end of the field ('' after a space). A `key:` token only applies once finished. */
const partialOf = (input: string) => (/\s$/.test(input) ? '' : input.match(/\S*$/)![0]);

/**
 * Full-screen search over the whole library ("/" opens it). Its state lives in the URL (`?q=` in the search
 * syntax), so back/forward, reload and shared links bring back the same search, and tags elsewhere link into it.
 */
export function SearchDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const index = useSearchIndex();
  const { savedIds } = useGameLibrary();
  const urlQ = new URLSearchParams(location.search).get('q');
  const open = urlQ !== null;

  const [filters, setFilters] = useState<Filter[]>([]);
  const [input, setInput] = useState('');
  const [idx, setIdx] = useState(0);
  const [sugIdx, setSugIdx] = useState(0);
  const [panel, setPanel] = useState<Key | null>(null);
  const [within, setWithin] = useState('');

  const partial = partialOf(input);
  const pending = !!facetKey(partial.match(/^-?([a-z]+):/i)?.[1] ?? ''); // `genre:rp` waits for its value; words (and `foo:bar`) search as you type
  const typed = parseQuery(pending ? input.slice(0, -partial.length) : input);
  const query: Query = { text: typed.text, filters: [...filters, ...typed.filters.filter((x) => !filters.some((y) => sameFilter(x, y)))] };
  const formatted = formatQuery(query);

  // URL → state: on a navigation (back/forward, a tag link, reload) that isn't the query already shown.
  const [seenKey, setSeenKey] = useState<string | null>(null);
  if (open && location.key !== seenKey) {
    setSeenKey(location.key);
    if (urlQ !== formatted) {
      const p = parseQuery(urlQ);
      setFilters(p.filters);
      setInput(p.text);
      setIdx(0);
      setPanel(null);
    }
  }

  // State → URL: typing replaces the entry (debounced, off the keystroke path); facet picks push one (see `apply`).
  useEffect(() => {
    if (!open || formatted === urlQ) return;
    const t = setTimeout(() => navigate(paths.search(formatted).slice(1), { replace: true, state: location.state }), 250);
    return () => clearTimeout(t);
  }, [open, formatted, urlQ, navigate, location.state]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const apply = (next: Filter[], text = query.text) => {
    setFilters(next);
    setInput(text ? `${text} ` : '');
    setIdx(0);
    navigate(paths.search(formatQuery({ text, filters: next })).slice(1), { state: location.state }); // one history entry per pick
  };
  const toggle = (x: Filter) => {
    const on = query.filters.some((y) => sameFilter(x, y));
    const rest = query.filters.filter((y) => !(y.key === x.key && y.value === x.value)); // include and exclude are exclusive
    apply(on ? rest : [...rest, x]);
  };
  const close = () => {
    setPanel(null);
    const from = (location.state as { from?: number } | null)?.from;
    const idx = (history.state as { idx?: number } | null)?.idx ?? 0; // live, not the last render's
    if (from !== undefined && idx > from) navigate(from - idx);
    else { // opened by a shared link or a reload: nothing of ours to step back to
      const p = new URLSearchParams(location.search);
      p.delete('q');
      navigate({ search: p.size ? `?${p}` : '' }, { replace: true });
    }
  };

  const q = searchKey(query.text);
  const any = !!q || query.filters.length > 0;
  const results = useMemo(() => any
    ? search(index, query)
    : index.items.map((it) => it.g).filter((g) => owned(g) && (g.lastPlayed || g.importedAt)).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0)),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `formatted` is the query
  [index, formatted, any]);
  const shown = results.slice(0, MAX_RESULTS);
  const sel = Math.min(idx, Math.max(0, shown.length - 1));

  const sugs = useMemo(() => (partial ? suggest(index, query, partial) : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `formatted` is the query
  [index, formatted, partial]);
  const sugSel = Math.min(sugIdx, Math.max(0, sugs.length - 1));

  /** Take a completion: `genre:` stays in the field for its value, a full `genre:rpg ` becomes a chip. */
  const accept = (insert: string) => onInput(input.slice(0, input.length - partial.length) + insert);
  const onInput = (v: string) => {
    setIdx(0);
    setSugIdx(0);
    const p = /\s$/.test(v) ? parseQuery(v) : null;
    if (p?.filters.length) apply([...filters, ...p.filters.filter((x) => !filters.some((y) => sameFilter(x, y)))], p.text);
    else setInput(v);
  };

  const focusables = () => [...ref.current!.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input')].filter((el) => el.offsetParent);
  const onKey = (e: KeyboardEvent<HTMLDialogElement>) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (panel) { setPanel(null); ref.current?.querySelector<HTMLElement>(`[data-facet="${panel}"]`)?.focus(); } // first Esc closes the sheet
      else close(); // one Esc closes, even with text in the field
      return;
    }
    if (t === inputRef.current) {
      if (e.key === 'Tab' && !e.shiftKey && sugs.length) { e.preventDefault(); accept(sugs[sugSel].insert); return; }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && pending && sugs.length) {
        e.preventDefault();
        setSugIdx((sugSel + (e.key === 'ArrowDown' ? 1 : -1) + sugs.length) % sugs.length);
        return;
      }
      if (e.key === 'ArrowUp' && sel === 0) { e.preventDefault(); ref.current?.querySelector<HTMLElement>('[data-facet]')?.focus(); return; } // up from the top result: the filters
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!shown.length) return;
        const next = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        setIdx(next);
        ref.current?.querySelectorAll('#sres [role=option]')[next]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (pending && sugs.length) accept(sugs[sugSel].insert);
        else if (pending) onInput(`${input} `);
        else if (shown[sel]) navigate(paths.game(shown[sel].id));
      } else if (e.key === 'Backspace' && !input && query.filters.length) {
        e.preventDefault();
        apply(query.filters.slice(0, -1), '');
      }
      return;
    }
    // Everywhere else in the overlay the arrows move focus on screen (TV remote, gamepad-as-keyboard).
    if (!e.key.startsWith('Arrow') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (t.tagName === 'INPUT' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || (t as HTMLInputElement).type === 'number')) return;
    // Into the open sheet: its search field, then its first value (not the Done button, nor a "Not").
    const into = (t.dataset.facet && panel === t.dataset.facet) || t.classList.contains('fwithin') ? ref.current?.querySelector<HTMLElement>(t.dataset.facet ? '.fwithin, .fv' : '.fv') : null;
    if (into && e.key === 'ArrowDown') { e.preventDefault(); into.focus(); return; }
    const next = spatialNext(t, e.key, focusables());
    if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  };

  const suggestion = (() => {
    if (!any || results.length) return null;
    const best = withoutEach(index, query).filter((x) => x.count).sort((a, b) => b.count - a.count).slice(0, 3);
    return { best };
  })();

  return (
    <dialog ref={ref} className="sdlg" aria-label="Search games" onCancel={(e) => { e.preventDefault(); close(); }} onKeyDown={onKey}>
      {open && (
        <div className="wrap">
          <div className="sbar">
            <svg className="icon" style={{ width: 36, height: 36 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
            <input ref={inputRef} type="search" placeholder={query.filters.length ? 'Add words' : 'Search games'} autoComplete="off" autoFocus spellCheck={false}
              role="combobox" aria-expanded={sugs.length > 0} aria-controls="ssug sres" aria-autocomplete="list"
              aria-activedescendant={sugs.length ? `sug-${sugSel}` : undefined} aria-describedby="shelp"
              value={input} onChange={(e) => onInput(e.target.value)} />
            <button className="close" aria-label="Close search" onClick={close}>{I.close}</button>
            {sugs.length > 0 && (
              <ul className="ssug" id="ssug" role="listbox" aria-label="Suggestions">
                {sugs.map((s, i) => (
                  <li key={s.insert} id={`sug-${i}`} role="option" aria-selected={i === sugSel}
                    onMouseDown={(e) => { e.preventDefault(); accept(s.insert); inputRef.current?.focus(); }}>
                    <b>{s.label}</b><span>{s.hint}</span>{s.count !== undefined && <span className="n">{s.count.toLocaleString('en-US')}</span>}
                    {i === sugSel && <kbd>Tab</kbd>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="fbar">
            <div className="chips" role="group" aria-label="Filters">
              {BAR.filter((k) => index.items.some((it) => it.v[k].length)).map((k) => {
                const n = query.filters.filter((x) => x.key === k || (k === 'decade' && x.key === 'year')).length;
                return (
                  <button key={k} className="chip" data-facet={k} aria-expanded={panel === k} aria-controls="fpanel"
                    aria-pressed={n > 0} onClick={() => { setPanel(panel === k ? null : k); setWithin(''); }}>
                    {facetLabel(k)}{n > 0 && <span className="n">{n}</span>}{I.down}
                  </button>
                );
              })}
            </div>
            {panel && <FacetSheet k={panel} query={query} within={within} setWithin={setWithin} toggle={toggle} apply={apply} onDone={() => { setPanel(null); inputRef.current?.focus(); }} />}
          </div>

          {query.filters.length > 0 && (
            <div className="active" role="group" aria-label="Active filters">
              {query.filters.map((x) => (
                <button key={`${x.neg}${x.key}${x.value}`} className={`fchip${x.neg ? ' neg' : ''}`} aria-label={`Remove ${chipText(x, index.labels)}`}
                  onClick={() => apply(query.filters.filter((y) => y !== x))}>
                  {chipText(x, index.labels)}{I.close}
                </button>
              ))}
              {query.filters.length > 1 && <button className="linkbtn" onClick={() => apply([])}>Clear filters</button>}
            </div>
          )}

          <div className="shint" id="shelp">
            <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span>
            <span className="syn">Type <code>genre:</code> <code>players:2</code> <code>-region:jp</code> <code>year:1990..1995</code> to filter</span>
            <span className="cnt" role="status">{any ? `${results.length.toLocaleString('en-US')} result${results.length === 1 ? '' : 's'}${results.length > MAX_RESULTS ? `, first ${MAX_RESULTS} shown` : ''}` : 'Recently played'}</span>
          </div>
          <ul className="sres" id="sres" role="listbox" aria-label="Results">
            {shown.length ? shown.map((g, i) => {
              const [kind, label] = tagOf(g, savedIds);
              return (
                <li key={g.id}>
                  <Link to={paths.game(g.id)} role="option" aria-selected={i === sel}>
                    <Cover game={g} aria-hidden />
                    <span className="t"><Hl text={g.title} q={q} /><small>{[byline(g), g.genre !== 'Unknown' ? g.genre : ''].filter(Boolean).join(' · ')}</small></span>
                    <span className={`tag ${kind}`} style={{ margin: 0 }}>{label}</span>
                  </Link>
                </li>
              );
            }) : (
              <li className="sempty">
                {suggestion?.best.length ? (
                  <>
                    <p>No game matches all of these{q ? <> with “{query.text}”</> : ''}.</p>
                    <div className="acts">
                      {suggestion.best.map(({ filter, count }) => (
                        <button key={`${filter.neg}${filter.key}${filter.value}`} className="btn line" onClick={() => apply(query.filters.filter((y) => y !== filter))}>
                          Remove {chipText(filter, index.labels)} <span className="n">{count.toLocaleString('en-US')} {count === 1 ? 'game' : 'games'}</span>
                        </button>
                      ))}
                    </div>
                  </>
                ) : query.filters.length ? (
                  <>No game matches {q ? <>“{query.text}” with these filters</> : 'these filters'}. <button className="linkbtn" onClick={() => apply([])}>Clear filters</button></>
                ) : q ? <>No game called “{query.text}”. Add it from your own files with Add ROMs.</> : 'Games you play show up here.'}
              </li>
            )}
          </ul>
        </div>
      )}
    </dialog>
  );
}

/** One facet's values with counts (paper sheet under the bar; a bottom sheet on phones). */
function FacetSheet({ k, query, within, setWithin, toggle, apply, onDone }: {
  k: Key; query: Query; within: string; setWithin: (s: string) => void;
  toggle: (x: Filter) => void; apply: (f: Filter[]) => void; onDone: () => void;
}) {
  const index = useSearchIndex();
  const counts = facetCounts(index, query, k);
  // Active values stay listed even when nothing else is left to count.
  const active = query.filters.filter((x) => x.key === k && !counts.some((v) => v.value === x.value)).map((x) => ({ value: x.value, label: valueLabel(k, x.value, index.labels), count: 0 }));
  const t = folded(within).s;
  const all = [...active, ...counts];
  const list = t ? all.filter((v) => ` ${folded(v.label).s}`.includes(` ${t}`) || folded(v.label).s.includes(t)) : all;
  const year = query.filters.find((x) => x.key === 'year' && !x.neg)?.value.split('..') ?? [];
  const setYear = (from: string, to: string) => {
    const rest = query.filters.filter((x) => x.key !== 'year');
    const v = normValue('year', from === to ? from : `${from}..${to}`);
    apply(v ? [...rest, { key: 'year', value: v }] : rest);
  };
  const state = (value: string) => query.filters.find((x) => x.key === k && x.value === value);

  return (
    <div className="fpanel paper" id="fpanel" role="group" aria-label={facetLabel(k)}>
      <div className="fhead">
        <h3>{facetLabel(k)}</h3>
        <button className="btn k" onClick={onDone}>Done</button>
      </div>
      {all.length > 12 && (
        <input className="fwithin" type="search" placeholder={`Find a ${facetLabel(k).toLowerCase()}`} aria-label={`Find a ${facetLabel(k).toLowerCase()}`}
          value={within} onChange={(e) => setWithin(e.target.value)} />
      )}
      {k === 'decade' && (
        <div className="years">
          <label>From <input type="number" inputMode="numeric" min={1989} max={2030} placeholder="1989" defaultValue={year[0] ?? ''} onBlur={(e) => setYear(e.target.value, year[1] ?? year[0] ?? '')} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>
          <label>To <input type="number" inputMode="numeric" min={1989} max={2030} placeholder="2003" defaultValue={year[1] ?? year[0] ?? ''} onBlur={(e) => setYear(year[0] ?? '', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>
        </div>
      )}
      {list.length ? (
        <ul className="fvals">
          {list.slice(0, MAX_VALUES).map((v) => {
            const s = state(v.value);
            return (
              <li key={v.value}>
                <button className="fv" aria-pressed={!!s && !s.neg} onClick={() => toggle({ key: k, value: v.value })}>
                  <span className="box" aria-hidden="true">{s && !s.neg ? I.check : null}</span>
                  <span className="l">{v.label}</span><span className="n">{v.count.toLocaleString('en-US')}</span>
                </button>
                <button className="fnot" aria-pressed={!!s?.neg} aria-label={`Exclude ${v.label}`} onClick={() => toggle({ key: k, value: v.value, neg: true })}>Not</button>
              </li>
            );
          })}
        </ul>
      ) : <p className="note" style={{ margin: 0 }}>{t ? `No ${facetLabel(k).toLowerCase()} matches “${within}”.` : 'Nothing to pick with the current search.'}</p>}
      {list.length > MAX_VALUES && <p className="note" style={{ margin: '10px 0 0' }}>{list.length - MAX_VALUES} more: type to narrow the list.</p>}
    </div>
  );
}
