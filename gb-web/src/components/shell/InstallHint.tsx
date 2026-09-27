import { useEffect, useRef, useState } from 'react';
import { device, isInstalled, isIosBrowser, isIosSafari } from '../../lib/pwa';
import { trapTab } from '../../lib/ui';
import { useSettingsStore } from '../../store/settingsStore';
import { I } from '../icons';
import { HINT_SEEN as SEEN, toast, useInstallSheet } from './actions';
import { rich, t as tNow, useT } from '../../i18n';

/** The Share › Add to Home Screen step: on iPhone and iPad, Safari has no install button. */
export function IosStep({ safari }: { safari?: boolean }) {
  const t = useT();
  return <span className="ios-step">{rich(t(safari ? 'shell.install.stepSafari' : 'shell.install.step'), { icon: <span className="glyph" aria-hidden="true">{I.share}</span>, b: (s) => <b>{s}</b> })}</span>;
}

/**
 * A one-time, non-blocking card on iPhone and iPad, in Safari only (never in the installed app), shown
 * once the first-launch box art question is answered so the two never stack. It counts as seen as soon as it shows.
 */
export function InstallHint() {
  const answered = useSettingsStore((s) => s.boxArtAnswer !== null);
  const t = useT();
  const [show] = useState(() => {
    try { return isIosSafari() && !isInstalled() && !localStorage.getItem(SEEN); } catch { return false; }
  });
  const [open, setOpen] = useState(true);
  const sheetUsed = useInstallSheet((s) => s.used);
  const visible = show && open && answered && !sheetUsed;
  useEffect(() => { if (visible) try { localStorage.setItem(SEEN, '1'); } catch { /* storage blocked */ } }, [visible]);
  if (!visible) return null;
  return (
    <aside className="ihint paper" aria-labelledby="ihint-t">
      <span className="bar" aria-hidden="true"><i /><i /><i /></span>
      <div className="in">
        <button className="x" aria-label={t('common.close')} onClick={() => setOpen(false)}>{I.close}</button>
        <h2 id="ihint-t">{t('shell.install.title', { device: device() })}</h2>
        <p><IosStep safari /><small>{t('shell.install.hint')}</small></p>
        <button className="btn k" onClick={() => setOpen(false)}>{t('common.gotIt')}</button>
      </div>
    </aside>
  );
}

/**
 * "Install the app" on iPhone and iPad (opened from the menu): Share, then Add to Home Screen, in Safari or
 * (iOS 16.4+) Chrome, Edge and Firefox. In-app browsers can't, so the page has to be opened in Safari first.
 */
export function InstallSheet() {
  const open = useInstallSheet((s) => s.open);
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (open && d && !d.open) d.showModal();
    if (!open && d?.open) d.close();
  }, [open]);
  const close = () => useInstallSheet.setState({ open: false });
  const safari = isIosSafari(), browser = isIosBrowser();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(new URL(import.meta.env.BASE_URL, location.href).href);
      toast(tNow('shell.install.copied'), 'c');
    } catch {
      toast(tNow('shell.install.copyFailed'), 'm');
    }
  };
  return (
    <dialog ref={ref} className="mdlg isheet" aria-labelledby="isheet-t" onClose={close} onKeyDown={trapTab}
      onClick={(e) => { if (e.target === ref.current) close(); }}>
      {open && (
        <>
          <span className="bar" aria-hidden="true"><i /><i /><i /></span>
          <div className="in">
            <h2 id="isheet-t">{t('shell.install.title', { device: device() })}</h2>
            {safari ? (
              <p><IosStep safari /><small>{t('shell.install.safari')}</small></p>
            ) : browser ? (
              <p><IosStep safari /><small>{t('shell.install.browser')}</small></p>
            ) : (
              <>
                <p>{rich(t('shell.install.openSafari'), { b: (s) => <b>{s}</b> })}</p>
                <p><IosStep /><small>{t('shell.install.then')}</small></p>
              </>
            )}
            <div className="acts">
              {!safari && !browser && <button className="btn line" onClick={copy}>{I.link}{t('shell.install.copy')}</button>}
              <button className="btn k" onClick={close} autoFocus>{t('common.gotIt')}</button>
            </div>
          </div>
        </>
      )}
    </dialog>
  );
}
