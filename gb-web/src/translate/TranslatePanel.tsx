import { useState, type ReactNode } from 'react';
import { LANG_NAMES, useT } from '../i18n';
import { ConfirmDialog, type ConfirmRequest } from '../components/shell/ConfirmDialog';
import { LANGS, useTranslate, type Provider } from './store';
import { liveSession, toggleTranslate } from './useLiveTranslate';
/** What the reader writes for a character it could not read (ocr.ts; not imported: the reader loads only when needed). */
const UNKNOWN = '□';
import './translate.css';

const CHROME_OK = { missing: 'bad', unavailable: 'bad', available: 'ok' } as Record<string, string>;

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
  const t = useT();
  const s = useTranslate();
  const on = !!s.games[gameId];
  const [draft, setDraft] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [fix, setFix] = useState('');
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const radio = (p: Provider, title: string, body: ReactNode, extra?: ReactNode) => (
    <li>
      <input type="radio" name="tl-prov" id={`tl-${p}`} checked={s.provider === p} onChange={() => s.set({ provider: p })} />
      <label htmlFor={`tl-${p}`}>{title}<small>{body}</small></label>
      {extra && <div style={{ gridColumn: 2 }}>{extra}</div>}
    </li>
  );
  const picked = pick === null ? null : s.seen.find((g) => g.key === pick) ?? null;
  const teach = (char: string | null) => { if (picked) liveSession()?.teach(picked.key, char); setPick(null); };
  const status = s.readerError || (on ? (s.ready ? t('translate.panel.reading') : t('translate.panel.starting')) : t('translate.panel.off'));
  return (
    <section className="trp">
      <h3>{t('translate.panel.title')}</h3>
      <p>{t('translate.panel.intro')}</p>
      <div className="row">
        <span>{t('translate.panel.live')}<small className={s.readerError ? 'bad' : undefined}>{status}</small></span>
        <button className="switch" role="switch" aria-checked={on} aria-label={t('translate.panel.live')} onClick={() => toggleTranslate(gameId, !on, true)} />
      </div>
      <div className="row col">
        <span>{t('translate.panel.into')}</span>
        <div className="seg langs" role="group" aria-label={t('translate.panel.into')}>
          {LANGS.map((k) => <button key={k} lang={k} aria-pressed={s.lang === k} onClick={() => s.set({ lang: k })}>{LANG_NAMES[k]}</button>)}
        </div>
      </div>
      <ul className="prov" role="radiogroup" aria-label={t('translate.panel.by')}>
        {radio('auto', t('translate.panel.auto'), t('translate.panel.autoSub'))}
        {radio('chrome', t('translate.panel.chrome'), t('translate.panel.chromeSub'),
          <span className={`st ${CHROME_OK[s.chrome] ?? ''}`}>{t(`translate.panel.chromeStatus.${s.chrome}`)}{s.chrome === 'downloading' && <i><b style={{ width: `${Math.round(s.chromeProgress * 100)}%` }} /></i>}</span>)}
        {radio('claude', t('translate.panel.claude'), t('translate.panel.claudeSub'),
          <>
            {s.claudeKey
              ? <span className={`st ${s.claudeError ? 'bad' : 'ok'}`}>{s.claudeError || t('translate.panel.keySaved')}</span>
              : <span className="st">{t('translate.panel.noKey')}</span>}
            <form className="tl-key" onSubmit={(e) => { e.preventDefault(); s.set({ claudeKey: draft.trim() }); setDraft(''); }}>
              <input className="field" type="password" autoComplete="off" spellCheck={false} placeholder={s.claudeKey ? '••••••••' + s.claudeKey.slice(-4) : 'sk-ant-…'}
                aria-label={t('translate.panel.keyLabel')} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button className="sbtn" type="submit" disabled={!draft.trim()}>{t('common.save')}</button>
              {s.claudeKey && <button className="sbtn" type="button" onClick={() => s.set({ claudeKey: '' })}>{t('translate.panel.forget')}</button>}
            </form>
            <label className="tl-remember">
              <input type="checkbox" checked={s.rememberKey} onChange={(e) => s.set({ rememberKey: e.target.checked })} />
              {t('translate.panel.remember')}
            </label>
            <p className="fine">{t('translate.panel.keyNote', { remembered: s.rememberKey ? '' : t('translate.panel.keyUntilClose') })}</p>
          </>)}
        {radio('none', t('translate.panel.none'), t('translate.panel.noneSub'))}
      </ul>
      {on && (
        <>
          <h3>{t('translate.panel.teach')}</h3>
          {s.seen.length ? (
            <>
              <p>{t('translate.panel.teachIntro', { unknown: UNKNOWN })}</p>
              <div className="chart" role="group" aria-label={t('translate.panel.chart')}>
                {s.seen.map((g, i) => (
                  <button key={i} aria-pressed={pick === g.key} aria-label={t('translate.panel.readAs', { char: g.char })} onClick={() => { setPick(g.key); setFix(g.char === UNKNOWN ? '' : g.char); }}>
                    <Tile k={g.key} /><b className={g.char === UNKNOWN ? 'unk' : ''}>{g.char}</b>
                  </button>
                ))}
              </div>
              {picked && (
                <>
                  {/* The reader's next guesses: one tap, no Japanese keyboard needed. */}
                  {!!picked.alts?.length && (
                    <div className="alts" role="group" aria-label={t('translate.panel.looksLike')}>
                      <span>{t('translate.panel.looksLike')}</span>
                      {picked.alts.filter((c) => c !== picked.char).map((c) => <button key={c} className="sbtn" lang="ja" onClick={() => teach(c)}>{c}</button>)}
                    </div>
                  )}
                  <form className="teach" onSubmit={(e) => { e.preventDefault(); teach(fix.trim() || ''); }}>
                    <input className="field" autoFocus lang="ja" maxLength={2} value={fix} onChange={(e) => setFix(e.target.value)} aria-label={t('translate.panel.right')} />
                    <button className="sbtn" type="submit">{fix.trim() ? t('translate.panel.correct') : t('translate.panel.notLetter')}</button>
                    <button className="sbtn" type="button" onClick={() => teach(null)}>{t('translate.panel.reset')}</button>
                  </form>
                </>
              )}
              <p className="fine">
                <button className="linkbtn" onClick={() => setConfirm({
                  title: t('translate.panel.forgetTitle'), body: t('translate.panel.forgetBody'), ok: t('translate.panel.forget'), danger: true,
                  run: () => liveSession()?.forgetAll(),
                })}>{t('translate.panel.forgetAll')}</button>
              </p>
            </>
          ) : <div className="empty-inline">{t('translate.panel.empty')}</div>}
        </>
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </section>
  );
}
