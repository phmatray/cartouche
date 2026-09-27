import { Link } from 'react-router';
import { device, isInstalled, isIos, promptInstall } from '../../lib/pwa';
import { IosStep } from '../shell/InstallHint';
import { toast } from '../shell/actions';
import { ShortcutsList } from '../shell/Shortcuts';
import { I, REPO_URL } from '../icons';
import { Row } from './parts';
import { rich, t as tNow, useT } from '../../i18n';

export function AboutTab() {
  const installed = isInstalled();
  const t = useT();
  const install = async () => {
    if (!(await promptInstall())) toast(tNow('settings.about.lookFor'), 'c');
  };
  return (
    <>
      <h2>{t('settings.tabs.about')}</h2>
      <p className="intro">{t('settings.about.intro')}</p>

      <Row label={t('settings.about.source')} sub={t('settings.about.sourceSub')}>
        <a className="btn line" style={{ color: 'var(--ink)' }} href={REPO_URL} target="_blank" rel="noopener">{I.github}{t('shell.github')}</a>
      </Row>

      <h3>{t('settings.about.data')}</h3>
      <p className="intro" style={{ margin: '8px 0 0' }}>
        {rich(t('settings.about.dataBody'), { a: (s) => <Link to="/settings/storage" style={{ color: 'var(--ink)' }}>{s}</Link>, ra: (s) => <Link to="/settings/achievements" style={{ color: 'var(--ink)' }}>{s}</Link> })}
      </p>

      <h3>{t('settings.about.install')}</h3>
      {installed ? (
        <Row label={t('settings.about.asApp')} sub={t('settings.about.installedSub')}>
          <button className="btn k" disabled>{t('settings.about.installed')}</button>
        </Row>
      ) : isIos() ? (
        <div className="row col ios-install">
          <span>{t('shell.install.title', { device: device() })}</span>
          <p>
            <IosStep />
            <small>{t('settings.about.ios')}</small>
          </p>
        </div>
      ) : (
        <Row label={t('settings.about.asApp')} sub={t('settings.about.asAppSub')}>
          <button className="btn k" onClick={install}>{t('settings.about.installBtn')}</button>
        </Row>
      )}

      <h3>{t('shell.shortcuts')}</h3>
      <ShortcutsList />

      <h3>{t('game.credits')}</h3>
      <p className="intro" style={{ margin: '8px 0 0' }}>
        {rich(t('settings.about.credits'), CREDIT_LINKS)}
      </p>
    </>
  );
}

const ink = { color: 'var(--ink)' };
const ext = (href: string) => (text: string) => <a href={href} target="_blank" rel="noreferrer" style={ink}>{text}</a>;
const base = import.meta.env.BASE_URL;
/** The links of the credits paragraph, by the tag that wraps each in the translated text. */
const CREDIT_LINKS = {
  ccby: ext('https://creativecommons.org/licenses/by/4.0/'),
  ccbysa: ext('https://creativecommons.org/licenses/by-sa/4.0/'),
  ofl: ext(`${base}licenses/OFL-Archivo.txt`),
  tobu: (s: string) => <Link to="/game/tobu-tobu-girl" style={ink}>{s}</Link>,
  tobudx: (s: string) => <Link to="/game/tobu-tobu-girl-deluxe" style={ink}>{s}</Link>,
  itch: ext('https://tangramgames.itch.io/tobutobugirl'),
  itchdx: ext('https://tangramgames.itch.io/tobu-tobu-girl-deluxe'),
  ucity: (s: string) => <Link to="/game/ucity" style={ink}>{s}</Link>,
  gpl: ext(`${base}licenses/GPL-3.0-ucity.txt`),
  src: ext('https://github.com/AntonioND/ucity/tree/v1.3'),
  sameboy: ext('https://github.com/LIJI32/SameBoy'),
  notices: ext(`${base}THIRD_PARTY_NOTICES.txt`),
  licenses: ext(`${base}THIRD_PARTY_LICENSES.txt`),
  ra: ext('https://retroachievements.org'),
  legal: (s: string) => <Link to="/legal" style={ink}>{s}</Link>,
};
