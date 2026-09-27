import { useEffect, useRef, useState } from 'react';
import { useT, type Key } from '../../i18n';
import { isInstalled, isIos } from '../../lib/pwa';

/**
 * The camera, reading a QR code. Inside the app on purpose: a Home Screen app on iPhone keeps its own storage,
 * apart from Safari's, so the code has to be read here, not by the Camera app. iOS Safari has no BarcodeDetector,
 * so frames are decoded in JavaScript (the `qr` package's decoder, loaded only when the camera opens).
 */
export function Scanner({ onCode, onClose }: { onCode: (text: string) => Promise<boolean>; onClose: () => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<Key | null>(null);
  const [live, setLive] = useState(false);
  const [miss, setMiss] = useState(false);
  const done = useRef(onCode);
  useEffect(() => { done.current = onCode; });

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0, last = 0, busy = false, stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('none');
      const reader = import('qr/decode.js');
      reader.catch(() => {}); // handled below, once the camera is held (so it's released either way)
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
      stream = s;
      if (stopped) return s.getTracks().forEach((t) => t.stop());
      const { default: decodeQR } = await reader.catch(() => { throw new Error('offline'); });
      const v = video.current!;
      v.srcObject = s;
      await v.play().catch(() => {});
      setLive(true);
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        if (busy || now - last < 120 || !ctx || v.readyState < 2) return;
        last = now;
        // At most 720 px across: enough for a phone-screen QR code, cheap enough for every few frames.
        const k = Math.min(1, 720 / v.videoWidth);
        canvas.width = Math.round(v.videoWidth * k);
        canvas.height = Math.round(v.videoHeight * k);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        let text: string;
        try { text = decodeQR(ctx.getImageData(0, 0, canvas.width, canvas.height)); } catch { return; } // no code in this frame
        busy = true;
        done.current(text).then((ok) => { busy = false; setMiss(!ok); if (ok) cancelAnimationFrame(raf); });
      };
      raf = requestAnimationFrame(tick);
    })().catch((e: unknown) => {
      stream?.getTracks().forEach((tr) => tr.stop());
      const name = e instanceof DOMException ? e.name : '';
      // A Home Screen app on iPhone asks again at each launch: there's no per-site setting to send the player to.
      setError(name === 'NotAllowedError' || name === 'SecurityError' ? (isIos() && isInstalled() ? 'sync.scan.deniedIos' : 'sync.scan.denied')
        : e instanceof Error && e.message === 'offline' ? 'sync.scan.offline' : 'sync.scan.none');
    });
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  return (
    <div className="sy-scan">
      <div className={`sy-view${live ? ' live' : ''}`}>
        <video ref={video} playsInline muted aria-label={t('sync.scan.view')} />
        <i className="sy-reticle" aria-hidden="true"><b /><b /><b /><b /></i>
        {!live && !error && <span className="sy-view-msg">{t('sync.scan.opening')}</span>}
        {error && <span className="sy-view-msg" role="alert">{t(error)}</span>}
      </div>
      <p className="sy-scan-hint" aria-live="polite">{miss ? t('sync.scan.notOurs') : t('sync.scan.aim')}</p>
      <button type="button" className="btn line" onClick={onClose}>{t('sync.scan.close')}</button>
    </div>
  );
}
