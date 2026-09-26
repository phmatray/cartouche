import { useEffect, useState } from 'react';
import { device, isInstalled, isIosSafari } from '../../lib/pwa';
import { useSettingsStore } from '../../store/settingsStore';
import { I } from '../icons';

const SEEN = 'cartouche-ios-install-hint';

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
  const visible = show && open && answered;
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
