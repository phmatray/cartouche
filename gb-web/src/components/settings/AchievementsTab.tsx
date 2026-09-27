import { useState, type FormEvent } from 'react';
import { checkCreds, getCreds, RaError, setCreds } from '../../lib/retroachievements';
import { rich, useT } from '../../i18n';
import { Row } from './parts';

/** RetroAchievements: connect with a username and web API key (never a password), read-only. */
export function AchievementsTab() {
  const t = useT();
  const [creds, setState] = useState(getCreds);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const connect = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const c = { user: String(f.get('user')).trim(), key: String(f.get('key')).trim() };
    if (!c.user || !c.key) return;
    setBusy(true); setErr('');
    try {
      await checkCreds(c);
      setCreds(c); setState(c);
    } catch (x) {
      setErr(x instanceof RaError && x.kind === 'auth' ? t('ra.refused') : t('ra.offline'));
    }
    setBusy(false);
  };
  const keys = (s: string) => <a href="https://retroachievements.org/settings" target="_blank" rel="noreferrer" style={{ color: 'var(--ink)' }}>{s}</a>;
  return (
    <>
      <h2>{t('ra.tab')}</h2>
      <p className="intro">{t('ra.intro')}</p>
      {creds ? (
        <Row label={t('ra.connected', { user: creds.user })} sub={t('ra.connectedSub')}>
          <button className="btn line" style={{ color: 'var(--ink)' }} onClick={() => { setCreds(null); setState(null); }}>{t('ra.disconnect')}</button>
        </Row>
      ) : (
        <form className="ra-form" onSubmit={connect}>
          <label><span>{t('ra.user')}</span><input className="field" name="user" autoComplete="username" autoCapitalize="none" spellCheck={false} required /></label>
          <label><span>{t('ra.key')}</span><input className="field" name="key" type="password" autoComplete="off" spellCheck={false} required /></label>
          <small>{rich(t('ra.keySub'), { a: keys })}</small>
          <button className="btn k" disabled={busy} aria-busy={busy}>{busy ? t('ra.checking') : t('ra.connect')}</button>
          {err && <p className="note" role="alert" style={{ margin: 0, color: 'var(--warn)' }}>{err}</p>}
        </form>
      )}
    </>
  );
}
