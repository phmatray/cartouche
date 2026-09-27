import { useCallback, useEffect, useRef, useState } from 'react';
import { grab, show, SENSOR_H, SENSOR_W } from './sensor';
import './peripherals.css';

type State = 'off' | 'asking' | 'live' | 'photo' | 'denied' | 'none';

const Flip = <svg className="icon s" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h4l2-3h4l2 3h4v13H4z" fill="none" stroke="currentColor" strokeWidth="2.2" /><path d="M9 12.5a3 3 0 0 1 5.2-2M15 13.5a3 3 0 0 1-5.2 2M14 8.5v2h-2M10 17.5v-2h2" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>;
const Mirror = <svg className="icon s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18" stroke="currentColor" strokeWidth="2" strokeDasharray="2 2" /><path d="M9 7 3 12l6 5zM15 7l6 5-6 5z" fill="none" stroke="currentColor" strokeWidth="2" /></svg>;

/**
 * The pocket camera's lens: the player's own camera (or a photo) feeds the cartridge's sensor.
 * Nothing is recorded or sent: frames go straight from the video element into the emulated sensor.
 */
export default function CameraDock({ feed, running }: { feed: (lum: Uint8Array) => void; running: boolean }) {
  const [state, setState] = useState<State>('off');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState('');
  const [mirror, setMirror] = useState(true);
  const [open, setOpen] = useState(true);
  const video = useRef<HTMLVideoElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const still = useRef<Uint8Array | null>(null);
  const supported = !!navigator.mediaDevices?.getUserMedia;

  const stop = useCallback(() => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; }, []);
  useEffect(() => stop, [stop]);

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
      setOpen(false); // the game shows the picture now: fold the lens down to a thumbnail, clear of the screen
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      setState(name === 'NotFoundError' || name === 'OverconstrainedError' ? 'none' : 'denied');
    }
  }, [stop]);

  // Every animation frame while playing: the video frame (or the photo) into the sensor, and the preview.
  useEffect(() => {
    if (state !== 'live' && state !== 'photo') return;
    let raf = 0;
    const loop = () => {
      const v = video.current;
      const lum = state === 'live' && v && v.readyState >= 2 ? grab(v, v.videoWidth, v.videoHeight, mirror) : still.current;
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
      still.current = grab(bmp, bmp.width, bmp.height, false);
      bmp.close();
      setState('photo');
    } catch { /* not a picture the browser can read: nothing changes */ }
  };

  const flip = () => {
    const i = devices.findIndex((d) => d.deviceId === device);
    const next = devices[(i + 1) % devices.length];
    if (next) void start(next.deviceId);
  };

  const pick = (
    <label className="cd-btn" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}>
      {state === 'photo' ? 'Other photo' : 'Use a photo'}
      <input type="file" accept="image/*" className="sr" tabIndex={-1} onChange={(e) => { void photo(e.target.files?.[0]); e.target.value = ''; }} />
    </label>
  );
  const lit = state === 'live' || state === 'photo';

  return (
    <section className={`cdock${open ? ' open' : ''}${lit ? ' lit' : ''}`} aria-label="Camera cartridge">
      <video ref={video} className="cd-video" playsInline muted aria-hidden="true" />
      <button className="cd-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="cd-lens"><canvas ref={preview} width={SENSOR_W} height={SENSOR_H} aria-label="What the camera cartridge sees" /></span>
        <span className="cd-t"><b>Lens</b><small>{state === 'live' ? 'Live' : state === 'photo' ? 'Photo' : 'Off'}</small></span>
        <i className="cd-led" aria-hidden="true" />
      </button>
      {open && (
        <div className="cd-body">
          {state === 'off' || state === 'asking' ? (
            <>
              <p>This cartridge has a camera. Let the game see through yours? The picture stays on this device: nothing is recorded or sent.</p>
              <div className="cd-acts">
                {supported && <button className="cd-btn y" disabled={state === 'asking'} onClick={() => void start()}>{state === 'asking' ? 'Waiting for permission…' : 'Use my camera'}</button>}
                {pick}
              </div>
            </>
          ) : state === 'denied' || state === 'none' ? (
            <>
              <p>{state === 'none' ? 'No camera found on this device.' : 'Camera access is blocked. Allow it for this site in your browser’s settings, then try again.'} A photo works too.</p>
              <div className="cd-acts">
                {state === 'denied' && <button className="cd-btn" onClick={() => void start()}>Try again</button>}
                {pick}
              </div>
            </>
          ) : (
            <div className="cd-acts">
              {state === 'live' && devices.length > 1 && (
                <>
                  <button className="cd-btn icon" onClick={flip} aria-label="Switch camera">{Flip}</button>
                  <select className="cd-sel" value={device} aria-label="Camera" onChange={(e) => void start(e.target.value)}>
                    {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
                  </select>
                </>
              )}
              {state === 'live' && <button className="cd-btn icon" aria-pressed={mirror} aria-label="Mirror" onClick={() => setMirror(!mirror)}>{Mirror}</button>}
              {state === 'photo' && supported && <button className="cd-btn" onClick={() => void start()}>Use my camera</button>}
              {pick}
              <button className="cd-btn" onClick={() => { stop(); setState('off'); feed(new Uint8Array(SENSOR_W * SENSOR_H)); }}>Turn off</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
