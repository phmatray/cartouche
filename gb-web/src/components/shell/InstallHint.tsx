import { useEffect, useRef, useState } from 'react';
import { device, isInstalled, isIosBrowser, isIosSafari } from '../../lib/pwa';
import { trapTab } from '../../lib/ui';
import { useSettingsStore } from '../../store/settingsStore';
import { I } from '../icons';
import { HINT_SEEN as SEEN, toast, useInstallSheet } from './actions';

/** The Share › Add to Home Screen step: on iPhone and iPad, Safari has no install button. */
export const IosStep = ({ safari }: { safari?: boolean }) => (
  <span className="ios-step">{safari ? 'Tap' : 'In Safari, tap'} <span className="glyph" aria-hidden="true">{I.share}</span><b>Share</b>, then <b>Add to Home Screen</b>.</span>
);

/**
 * A one-time, non-blocking card on iPhone and iPad, in Safari only (never in the installed app), shown
 * once the first-launch box art question is answered so the two never stack. It counts as seen as soon as it shows.
 */
export function InstallHint() {
  const answered = useSettingsStore((s) => s.boxArtAnswer !== null);
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
        <button className="x" aria-label="Close" onClick={() => setOpen(false)}>{I.close}</button>
        <h2 id="ihint-t">Install on your {device()}</h2>
        <p><IosStep safari /><small>It opens full screen, plays offline and keeps your saves. On recent iOS, Share is in the ⋯ menu.</small></p>
        <button className="btn k" onClick={() => setOpen(false)}>Got it</button>
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
      toast('Link copied: paste it in Safari’s address bar', 'c');
    } catch {
      toast('Couldn’t copy: open the Share menu and choose Open in Safari', 'm');
    }
  };
  return (
    <dialog ref={ref} className="mdlg isheet" aria-labelledby="isheet-t" onClose={close} onKeyDown={trapTab}
      onClick={(e) => { if (e.target === ref.current) close(); }}>
      {open && (
        <>
          <span className="bar" aria-hidden="true"><i /><i /><i /></span>
          <div className="in">
            <h2 id="isheet-t">Install on your {device()}</h2>
            {safari ? (
              <p><IosStep safari /><small>On recent iOS, Share is in the ⋯ menu. Cartouche then opens full screen from its icon, plays offline and keeps your saves.</small></p>
            ) : browser ? (
              <p><IosStep safari /><small>Share is in the address bar or the browser’s menu. Cartouche then opens full screen from its icon, plays offline and keeps your saves.</small></p>
            ) : (
              <>
                <p><b>Open this page in Safari first.</b> This browser can’t add an app to the Home Screen.</p>
                <p><IosStep /><small>It then opens full screen from its icon, plays offline and keeps your saves.</small></p>
              </>
            )}
            <div className="acts">
              {!safari && !browser && <button className="btn line" onClick={copy}>{I.link}Copy link</button>}
              <button className="btn k" onClick={close} autoFocus>Got it</button>
            </div>
          </div>
        </>
      )}
    </dialog>
  );
}
