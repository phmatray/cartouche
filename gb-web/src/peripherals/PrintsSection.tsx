import { useEffect, useMemo, useState } from 'react';
import type { StoredScreenshot } from '../lib/db';
import { ago } from '../lib/ui';
import { I } from '../components/icons';
import { download, printOut, share, upscale } from './output';
import './peripherals.css';

const name = (gameId: string, t: number) => `${gameId}-print-${new Date(t).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;

function Strip({ s, title }: { s: StoredScreenshot; title: string }) {
  const url = useMemo(() => URL.createObjectURL(s.png), [s.png]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  // The 4× file is made ahead of time: the share sheet must open straight from the tap (iPhone).
  const [big, setBig] = useState<Blob | null>(null);
  useEffect(() => { let on = true; upscale(s.png, 4).then((b) => { if (on) setBig(b); }).catch(() => {}); return () => { on = false; }; }, [s.png]);
  const file = name(s.gameId, s.timestamp);
  return (
    <figure className="pr-strip">
      <img src={url} alt={`Print, ${ago(s.timestamp)}`} />
      <figcaption>
        <span>{ago(s.timestamp)}</span>
        <span className="pr-acts">
          <button className="sbtn" disabled={!big} onClick={() => big && download(big, file)} aria-label="Save as PNG">{I.save}</button>
          <button className="sbtn" disabled={!big} onClick={() => big && void share(big, file, title)} aria-label="Share">{I.share}</button>
          <button className="sbtn" onClick={() => printOut(s.png, `${title} · printed ${new Date(s.timestamp).toLocaleDateString()}`)}>Print</button>
        </span>
      </figcaption>
    </figure>
  );
}

/** Album › Prints: what came out of the Game Boy Printer, as it came out. */
export default function PrintsSection({ prints, title }: { prints: StoredScreenshot[]; title: string }) {
  return (
    <>
      <h3>Prints</h3>
      <p>From the Game Boy Printer. Save and Share give a 4× PNG with every dot kept sharp.</p>
      <div className="pr-grid">{prints.map((s) => <Strip key={s.id} s={s} title={title} />)}</div>
    </>
  );
}
