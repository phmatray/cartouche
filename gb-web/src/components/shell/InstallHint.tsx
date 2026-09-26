import { useEffect, useState } from 'react';
import { device, isInstalled, isIos } from '../../lib/pwa';
import { useSettingsStore } from '../../store/settingsStore';
import { I } from '../icons';

const SEEN = 'cartouche-ios-install-hint';

/** How to install on iPhone and iPad, where Safari has no install button: the Share sheet. */
export function IosSteps() {
  return (
    <>
      <span className="ios-step">Tap <span className="glyph" aria-hidden="true">{I.share}</span><b>Share</b>, then <b>Add to Home Screen</b>.</span>
      <small>On recent iOS, Share is in Safari’s ⋯ menu. Cartouche then opens full screen from its icon, plays offline, and keeps its storage: Safari can delete a website’s data after 7 days of use without a visit, and Home Screen apps aren’t subject to that.</small>
    </>
  );
}

/**
 * A one-time, non-blocking card on iPhone and iPad, in the browser only (never in the installed app), shown
 * once the first-launch box art question is answered so the two never stack. It counts as seen as soon as it shows.
 */
export function InstallHint() {
  const answered = useSettingsStore((s) => s.boxArtAnswer !== null);
  const [show] = useState(() => {
    try { return isIos() && !isInstalled() && !localStorage.getItem(SEEN); } catch { return false; }
  });
  const [open, setOpen] = useState(true);
  const visible = show && open && answered;
  useEffect(() => { if (visible) try { localStorage.setItem(SEEN, '1'); } catch { /* storage blocked */ } }, [visible]);
  if (!visible) return null;
  return (
    <aside className="ihint paper" aria-labelledby="ihint-t">
      <span className="bar" aria-hidden="true"><i /><i /><i /></span>
      <div className="in">
        <h2 id="ihint-t">Install on your {device()}</h2>
        <p><IosSteps /></p>
        <button className="btn k" onClick={() => setOpen(false)}>Got it</button>
      </div>
    </aside>
  );
}
