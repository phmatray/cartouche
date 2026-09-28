import { useState, type FormEvent } from 'react';
import { checkCreds, getCreds, RaError, setCreds } from '../../lib/retroachievements';
import { getPlay, signIn, signOut } from '../../lib/ra-client';
import { rich, useT } from '../../i18n';
import { Row } from './parts';

/** RetroAchievements: the achievements earned (username and web API key), and unlocking while playing (password once). */
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
      c.user = await checkCreds(c);
      setCreds(c); setState(c);
    } catch (x) {
      const kind = x instanceof RaError ? x.kind : 'net';
      setErr(kind === 'auth' ? t('ra.refused') : kind === 'missing' ? t('ra.noUser') : t('ra.offline'));
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
      <Unlocking />
    </>
  );
}

/** Unlocking while playing (lib/ra-client): the password once, for the session token RetroAchievements gives back. */
function Unlocking() {
  const t = useT();
  const [me, setMe] = useState(getPlay);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const user = String(f.get('user')).trim(), password = String(f.get('password'));
    if (!user || !password) return;
    setBusy(true); setErr('');
    try { setMe(await signIn(user, password)); } catch (x) { setErr(t('ra.playFailed', { error: (x as Error).message || t('ra.offline') })); }
    setBusy(false);
  };
  return (
    <>
      <h3>{t('ra.playTitle')}</h3>
      <p className="intro">{t('ra.playIntro')}</p>
      {me ? (
        <Row label={t('ra.playOn', { user: me.user })} sub={t('ra.playOnSub')}>
          <button className="btn line" style={{ color: 'var(--ink)' }} onClick={() => { signOut(); setMe(null); }}>{t('ra.playOff')}</button>
        </Row>
      ) : (
        <form className="ra-form" onSubmit={go}>
          <label><span>{t('ra.user')}</span><input className="field" name="user" defaultValue={getCreds()?.user} autoComplete="username" autoCapitalize="none" spellCheck={false} required /></label>
          <label><span>{t('ra.password')}</span><input className="field" name="password" type="password" autoComplete="current-password" required /></label>
          <button className="btn k" disabled={busy} aria-busy={busy}>{busy ? t('ra.signingIn') : t('ra.signIn')}</button>
          {err && <p className="note" role="alert" style={{ margin: 0, color: 'var(--warn)' }}>{err}</p>}
        </form>
      )}
    </>
  );
}
