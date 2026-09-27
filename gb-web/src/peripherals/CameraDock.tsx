import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { grab, show, SENSOR_H, SENSOR_W } from './sensor';
import './peripherals.css';

type State = 'off' | 'asking' | 'live' | 'photo' | 'denied' | 'none';

const Flip = <svg className="icon s" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h4l2-3h4l2 3h4v13H4z" fill="none" stroke="currentColor" strokeWidth="2.2" /><path d="M9 12.5a3 3 0 0 1 5.2-2M15 13.5a3 3 0 0 1-5.2 2M14 8.5v2h-2M10 17.5v-2h2" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>;
const Mirror = <svg className="icon s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18" stroke="currentColor" strokeWidth="2" strokeDasharray="2 2" /><path d="M9 7 3 12l6 5zM15 7l6 5-6 5z" fill="none" stroke="currentColor" strokeWidth="2" /></svg>;

/**
 * The pocket camera's lens: the player's own camera (or a photo) feeds the cartridge's sensor.
 * Nothing is recorded or sent: frames go straight from the video element into the emulated sensor.
 * The camera is released while the game is paused or the page hidden, and taken back on return.
 */
export default function CameraDock({ feed, running }: { feed: (lum: Uint8Array) => void; running: boolean }) {
  const t = useT();
  const [state, setState] = useState<State>('off');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState('');
  const [mirror, setMirror] = useState(true);
  // Phones start folded: open, the prompt would sit on the touch controls. The header (lens, "Off") unfolds it.
  const [open, setOpen] = useState(() => !matchMedia('(pointer: coarse)').matches);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const video = useRef<HTMLVideoElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const still = useRef<Uint8Array | null>(null);
  const supported = !!navigator.mediaDevices?.getUserMedia;

  const stop = useCallback(() => { stream.current?.getTracks().forEach((tr) => tr.stop()); stream.current = null; }, []);
  useEffect(() => stop, [stop]);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  const start = useCallback(async (id?: string) => {
    stop();
    setState('asking');
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: id ? { deviceId: { exact: id }, width: { ideal: 640 } } : { facingMode: 'user', width: { ideal: 640 } },
      });
      stream.current = s;
      const track = s.getVideoTracks()[0];
      const set = track?.getSettings();
      setDevice(set?.deviceId ?? id ?? '');
      setMirror(set?.facingMode !== 'environment'); // a selfie is mirrored, like a mirror; the back camera is not
      if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => {}); }
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'videoinput'));
      setState('live');
      setOpen(false); // the game shows the picture now: fold the lens down, clear of the screen and the controls
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      setState(name === 'NotFoundError' || name === 'OverconstrainedError' ? 'none' : 'denied');
    }
  }, [stop]);

  // Paused or hidden: the camera (and its indicator light) is released; playing again takes it back.
  const awake = running && visible;
  const resumeId = useRef<string | null>(null);
  useEffect(() => {
    if (state !== 'live') return;
    if (!awake && stream.current) { resumeId.current = device; stop(); }
    else if (awake && resumeId.current !== null) {
      const id = resumeId.current;
      resumeId.current = null;
      void Promise.resolve().then(() => start(id || undefined));
    }
  }, [awake, state, device, start, stop]);

  // Every animation frame while playing: the video frame (or the photo) into the sensor, and the preview.
  useEffect(() => {
    if (state !== 'live' && state !== 'photo') return;
    let raf = 0;
    const loop = () => {
      const v = video.current;
      const lum = state === 'live' ? (stream.current && v && v.readyState >= 2 ? grab(v, v.videoWidth, v.videoHeight, mirror) : null) : still.current;
      if (lum) { if (running) feed(lum); show(preview.current, lum); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state, mirror, running, feed]);

  const photo = async (f: File | undefined) => {
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      stop();
      resumeId.current = null;
      still.current = grab(bmp, bmp.width, bmp.height, false);
      bmp.close();
      setState('photo');
      setOpen(false);
    } catch { /* not a picture the browser can read: nothing changes */ }
  };

  const flip = () => {
    const i = devices.findIndex((d) => d.deviceId === device);
    const next = devices[(i + 1) % devices.length];
    if (next) void start(next.deviceId);
  };

  const pick = (
    <label className="cd-btn" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}>
      {state === 'photo' ? t('periph.lens.otherPhoto') : t('periph.lens.usePhoto')}
      <input type="file" accept="image/*" className="sr" tabIndex={-1} onChange={(e) => { void photo(e.target.files?.[0]); e.target.value = ''; }} />
    </label>
  );
  const lit = (state === 'live' && awake) || state === 'photo';
  const status = state === 'live' ? (awake ? t('periph.lens.live') : t('periph.lens.paused')) : state === 'photo' ? t('periph.lens.photo') : open ? t('periph.lens.off') : t('periph.lens.setUp');

  return (
    <section className={`cdock${open ? ' open' : ''}${lit ? ' lit' : ''}`} aria-label={t('periph.lens.label')}>
      <video ref={video} className="cd-video" playsInline muted aria-hidden="true" />
      <button className="cd-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="cd-lens"><canvas ref={preview} width={SENSOR_W} height={SENSOR_H} aria-label={t('periph.lens.sees')} /></span>
        <span className="cd-t"><b>{t('periph.lens.name')}</b><small>{status}</small></span>
        <i className="cd-led" aria-hidden="true" />
      </button>
      {open && (
        <div className="cd-body">
          {state === 'off' || state === 'asking' ? (
            <>
              <p>{t('periph.lens.ask')}</p>
              <div className="cd-acts">
                {supported && <button className="cd-btn y" disabled={state === 'asking'} onClick={() => void start()}>{state === 'asking' ? t('periph.lens.waiting') : t('periph.lens.useCamera')}</button>}
                {pick}
              </div>
            </>
          ) : state === 'denied' || state === 'none' ? (
            <>
              <p>{state === 'none' ? t('periph.lens.none') : t('periph.lens.denied')}</p>
              <div className="cd-acts">
                {state === 'denied' && <button className="cd-btn" onClick={() => void start()}>{t('periph.lens.retry')}</button>}
                {pick}
              </div>
            </>
          ) : (
            <div className="cd-acts">
              {state === 'live' && devices.length > 1 && (
                <>
                  <button className="cd-btn icon" onClick={flip} aria-label={t('periph.lens.switch')}>{Flip}</button>
                  <select className="cd-sel" value={device} aria-label={t('periph.lens.camera')} onChange={(e) => void start(e.target.value)}>
                    {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || t('periph.lens.cameraN', { n: i + 1 })}</option>)}
                  </select>
                </>
              )}
              {state === 'live' && <button className="cd-btn icon" aria-pressed={mirror} aria-label={t('periph.lens.mirror')} onClick={() => setMirror(!mirror)}>{Mirror}</button>}
              {state === 'photo' && supported && <button className="cd-btn" onClick={() => void start()}>{t('periph.lens.useCamera')}</button>}
              {pick}
              <button className="cd-btn" onClick={() => { stop(); resumeId.current = null; setState('off'); feed(new Uint8Array(SENSOR_W * SENSOR_H)); }}>{t('periph.lens.turnOff')}</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
