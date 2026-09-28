import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { I } from '../components/icons';
import { toast } from '../components/shell/actions';
import { date, t as tNow, useT } from '../i18n';
import { download, printOut, share } from './output';
import { MS_PER_ROW, PAPER_W, paperRgba } from './paper';
import type { Printout } from './usePeripherals';
import './peripherals.css';
import { reducedMotion } from '../lib/ui';

const PrinterIcon = <svg className="icon s" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V3h10v6M7 17H4v-8h16v8h-3M7 14h10v7H7z" fill="none" stroke="currentColor" strokeWidth="2.2" /></svg>;

const fileName = (gameId: string, id: number) => `${gameId}-print-${new Date(id).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;

/**
 * The Game Boy Printer's output tray: the paper feeds out of the slot band by band as the game prints,
 * tears off when the print is done, and goes to the album. Reduced motion: it appears at once.
 */
export default function PrinterTray({ paper, gameId, title, onClose }: { paper: Printout; gameId: string; title: string; onClose: () => void }) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current?.getContext('2d');
    if (c) c.putImageData(new ImageData(paperRgba(paper.shades), PAPER_W, paper.rows), 0, 0);
  }, [paper.shades, paper.rows]);
  // Tear-off and buttons wait for the paper to finish feeding (the feed runs in real time, whatever the speed).
  const [fedRows, setFedRows] = useState(0);
  const fed = paper.done && (fedRows === paper.rows || reducedMotion());
  // A finished print leaves the screen after a while (it is in the album), unless the player is on the tray.
  const tray = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!fed) return;
    let t = window.setTimeout(onClose, 12000);
    const hold = () => clearTimeout(t);
    const resume = () => { clearTimeout(t); t = window.setTimeout(onClose, 6000); };
    const el = tray.current;
    el?.addEventListener('pointerenter', hold); el?.addEventListener('focusin', hold);
    el?.addEventListener('pointerleave', resume); el?.addEventListener('focusout', resume);
    return () => { clearTimeout(t); el?.removeEventListener('pointerenter', hold); el?.removeEventListener('focusin', hold); el?.removeEventListener('pointerleave', resume); el?.removeEventListener('focusout', resume); };
  }, [fed, onClose]);
  const added = paper.rows - paper.from;
  const style = {
    '--rows': paper.rows, '--from': paper.from, '--bands': Math.max(1, Math.ceil(added / 8)), '--ms': `${added * MS_PER_ROW}ms`,
  } as CSSProperties;
  const name = fileName(gameId, paper.id);
  const caption = t('periph.printer.caption', { title, date: date(paper.id, { day: 'numeric', month: 'short', year: 'numeric' }) });

  return (
    <section ref={tray} className={`ptray${fed ? ' fed' : ''}`} aria-label={t('periph.printer.label')}>
      <div className="pt-out">
        {/* keyed by length: every new job feeds from where the last one stopped */}
        <div key={paper.rows} className={`pt-paper${fed ? ' torn' : ''}`} style={style} onAnimationEnd={() => setFedRows(paper.rows)} onClick={fed ? onClose : undefined}>
          <canvas ref={canvas} width={PAPER_W} height={paper.rows} aria-label={t('periph.printer.strip', { w: PAPER_W, h: paper.rows })} />
        </div>
      </div>
      <div className="pt-body">
        <i className="pt-slot" aria-hidden="true" />
        <div className="pt-row">
          <span className={`pt-led${fed ? '' : ' busy'}`} aria-hidden="true" />
          <span className="pt-state" role="status">{fed ? <>{PAPER_W} × {paper.rows}<span className="pt-long"> · {t('periph.printer.inAlbum')}</span></> : t('periph.printer.printing')}</span>
          <button className="pt-x" onClick={onClose} aria-label={t('periph.printer.close')}>{I.close}</button>
        </div>
        {fed && paper.png && (
          <div className="pt-acts">
            <button className="pt-btn" aria-label={t('periph.printer.saveLong')} onClick={() => { download(paper.png!, name); toast(tNow('periph.printer.saved'), 'c'); }}>{I.save}<span>{t('periph.printer.save')}</span></button>
            <button className="pt-btn" aria-label={t('periph.printer.share')} onClick={() => void share(paper.png!, name, title)}>{I.share}<span>{t('periph.printer.share')}</span></button>
            <button className="pt-btn" aria-label={t('periph.printer.printLong')} onClick={() => printOut(paper.png!, caption)}>{PrinterIcon}<span>{t('periph.printer.print')}</span></button>
          </div>
        )}
      </div>
    </section>
  );
}
