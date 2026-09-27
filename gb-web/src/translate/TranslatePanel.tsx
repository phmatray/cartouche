import { useState, type ReactNode } from 'react';
import { LANGS, useTranslate, type ChromeStatus, type Provider } from './store';
import { liveSession, toggleTranslate } from './useLiveTranslate';
/** What the reader writes for a character it could not read (ocr.ts; not imported: the reader loads only when needed). */
const UNKNOWN = '□';
import './translate.css';

const CHROME: Record<ChromeStatus, [string, 'ok' | 'bad' | '']> = {
  checking: ['Checking…', ''], missing: ['Not in this browser', 'bad'], unavailable: ['No model for this language', 'bad'],
  downloadable: ['Downloads when you turn it on', ''], downloading: ['Downloading', ''], available: ['Ready', 'ok'],
};

/** An 8x8 bitmap key (16 hex digits, row bytes) as crisp pixels. */
function Tile({ k }: { k: string }) {
  let d = '';
  for (let r = 0; r < 8; r++) {
    const row = parseInt(k.slice(r * 2, r * 2 + 2), 16);
    for (let c = 0; c < 8; c++) if (row & (0x80 >> c)) d += `M${c} ${r}h1v1h-1z`;
  }
  return <svg viewBox="0 0 8 8" aria-hidden="true"><path d={d} fill="currentColor" /></svg>;
}

/** Manual › Game › Translate: the switch, the language, who translates, and the teaching chart. */
export function TranslatePanel({ gameId }: { gameId: string }) {
  const s = useTranslate();
  const on = !!s.games[gameId];
  const [draft, setDraft] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [fix, setFix] = useState('');
  const chrome = CHROME[s.chrome];
  const radio = (p: Provider, title: string, body: ReactNode, extra?: ReactNode) => (
    <li>
      <input type="radio" name="tl-prov" id={`tl-${p}`} checked={s.provider === p} onChange={() => s.set({ provider: p })} />
      <label htmlFor={`tl-${p}`}>{title}<small>{body}</small></label>
      {extra && <div style={{ gridColumn: 2 }}>{extra}</div>}
    </li>
  );
  const teach = (char: string | null) => { if (pick) liveSession()?.teach(pick, char); setPick(null); };
  return (
    <section className="trp">
      <h3>Translate</h3>
      <p>Reads the text the game draws, straight from its tiles, and pins a translation over it. Made for Japanese games; English ones work roughly.</p>
      <div className="row">
        <span>Live translate<small>{on ? (s.ready ? 'Reading the screen' : 'Starting…') : 'Off for this game'}</small></span>
        <button className="switch" role="switch" aria-checked={on} aria-label="Live translate" onClick={() => toggleTranslate(gameId, !on)} />
      </div>
      <div className="row col">
        <span>Translate into</span>
        <div className="seg langs" role="group" aria-label="Translate into">
          {LANGS.map(([k, name]) => <button key={k} aria-pressed={s.lang === k} onClick={() => s.set({ lang: k })}>{name}</button>)}
        </div>
      </div>
      <ul className="prov" role="radiogroup" aria-label="Translated by">
        {radio('auto', 'Best available', 'Chrome’s translator when this browser has one, else Claude if you added a key, else the text as read.')}
        {radio('chrome', 'Chrome, on this device', 'Free and private: nothing leaves the browser. Desktop Chrome 138 or later; not on iPhone or iPad.',
          <span className={`st ${chrome[1]}`}>{chrome[0]}{s.chrome === 'downloading' && <i><b style={{ width: `${Math.round(s.chromeProgress * 100)}%` }} /></i>}</span>)}
        {radio('claude', 'Claude, with your API key',
          <>Better with misread characters and names, and it teaches the reader. Each line goes to Anthropic with the game’s title, billed to your key: about $1 per 2,000 lines with Claude Haiku 4.5. The key stays in this browser.</>,
          <>
            {s.claudeKey
              ? <span className={`st ${s.claudeError ? 'bad' : 'ok'}`}>{s.claudeError || 'Key saved'}</span>
              : <span className="st">No key yet</span>}
            <form className="tl-key" onSubmit={(e) => { e.preventDefault(); s.set({ claudeKey: draft.trim() }); setDraft(''); }}>
              <input className="field" type="password" autoComplete="off" spellCheck={false} placeholder={s.claudeKey ? '••••••••' + s.claudeKey.slice(-4) : 'sk-ant-…'}
                aria-label="Anthropic API key" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button className="sbtn" type="submit" disabled={!draft.trim()}>Save</button>
              {s.claudeKey && <button className="sbtn" type="button" onClick={() => s.set({ claudeKey: '' })}>Forget</button>}
            </form>
          </>)}
        {radio('none', 'Don’t translate', 'Show the text as read, to check it or copy it.')}
      </ul>
      {on && (
        <>
          <h3>Teach</h3>
          {s.seen.length ? (
            <>
              <p>Every game draws its own letters, so some come out wrong ({UNKNOWN} could not be read). Tap one to correct it: this game remembers.</p>
              <div className="chart" role="group" aria-label="Last text read">
                {s.seen.map((g, i) => (
                  <button key={i} aria-pressed={pick === g.key} aria-label={`Read as ${g.char}, correct it`} onClick={() => { setPick(g.key); setFix(g.char === UNKNOWN ? '' : g.char); }}>
                    <Tile k={g.key} /><b className={g.char === UNKNOWN ? 'unk' : ''}>{g.char}</b>
                  </button>
                ))}
              </div>
              {pick && (
                <form className="teach" onSubmit={(e) => { e.preventDefault(); teach(fix.trim() || ''); }}>
                  <input className="field" autoFocus lang="ja" maxLength={2} value={fix} onChange={(e) => setFix(e.target.value)} aria-label="The right character" />
                  <button className="sbtn" type="submit">{fix.trim() ? 'Correct' : 'Not a letter'}</button>
                  <button className="sbtn" type="button" onClick={() => teach(null)}>Undo</button>
                </form>
              )}
              <p className="fine"><button className="linkbtn" onClick={() => liveSession()?.forgetAll()}>Forget this game’s corrections</button></p>
            </>
          ) : <div className="empty-inline">When the game shows text, its characters appear here to check.</div>}
        </>
      )}
    </section>
  );
}
