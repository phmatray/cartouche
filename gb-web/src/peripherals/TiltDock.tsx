import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { motionToTilt, orientationToMotion, type ScreenAngle, type Tilt, type TiltSource } from './tilt';
import './peripherals.css';

type State = 'off' | 'asking' | 'listening' | 'live' | 'denied' | 'none';

/** No reading this long after permission: the device has no motion sensor (most computers). */
const NO_SENSOR_MS = 1500;

const screenAngle = (): ScreenAngle => {
  const a = screen.orientation?.angle ?? (window as { orientation?: number }).orientation ?? 0;
  return (((Math.round(a / 90) * 90) % 360) + 360) % 360 as ScreenAngle;
};

/**
 * The MBC7 tilt sensor's dock: turns the device's motion sensor on (iOS asks for permission, which must come
 * from the tap itself), recenters it, and names the tilt source in use. Motion readings go to `onMotion`;
 * the frame loop (usePeripherals) picks between them, a pad's right stick and I/J/K/L.
 */
export default function TiltDock({ onMotion, recenter, source }: { onMotion: (m: Tilt | null) => void; recenter: () => void; source: TiltSource }) {
  const t = useT();
  const [state, setState] = useState<State>('off');
  // Phones start folded, clear of the touch controls; the header unfolds it.
  const [open, setOpen] = useState(() => !matchMedia('(pointer: coarse)').matches);
  const supported = typeof DeviceMotionEvent !== 'undefined';
  const on = state === 'listening' || state === 'live';

  const use = () => {
    // iOS 13+: requestPermission must be called in the tap's own handler, before any await.
    const req = (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<PermissionState> }).requestPermission;
    setState('asking');
    (req ? req.call(DeviceMotionEvent) : Promise.resolve<PermissionState>('granted'))
      .then((r) => setState(r === 'granted' ? 'listening' : 'denied'), () => setState('denied'));
  };

  useEffect(() => {
    if (!on) return;
    let gravity = false;
    const put = (a: { x: number; y: number; z: number }) => { onMotion(motionToTilt(a, screenAngle(), { x: 0, y: 0 })); setState('live'); };
    const motion = (e: DeviceMotionEvent) => {
      const g = e.accelerationIncludingGravity;
      if (g?.x == null || g.y == null) return;
      gravity = true;
      put({ x: g.x, y: g.y, z: g.z ?? 0 });
    };
    // No gravity reading (some browsers): the orientation angles stand in.
    const orient = (e: DeviceOrientationEvent) => { if (!gravity && e.beta != null && e.gamma != null) put(orientationToMotion(e.beta, e.gamma)); };
    window.addEventListener('devicemotion', motion);
    window.addEventListener('deviceorientation', orient);
    const quiet = setTimeout(() => setState((s) => (s === 'listening' ? 'none' : s)), NO_SENSOR_MS);
    return () => {
      clearTimeout(quiet);
      window.removeEventListener('devicemotion', motion);
      window.removeEventListener('deviceorientation', orient);
      onMotion(null);
    };
  }, [on, onMotion]);

  const status = state === 'asking' ? t('periph.tilt.waiting') : t(`periph.tilt.source.${source}`);
  return (
    <section className={`cdock${open ? ' open' : ''}${state === 'live' ? ' lit' : ''}`} aria-label={t('periph.tilt.label')}>
      <button className="cd-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="cd-t"><b>{t('periph.tilt.name')}</b><small>{status}</small></span>
        <i className="cd-led" aria-hidden="true" />
      </button>
      {open && (
        <div className="cd-body">
          {state === 'live' ? (
            <>
              <p>{t('periph.tilt.recenterSub')}</p>
              <div className="cd-acts"><button className="cd-btn y" onClick={recenter}>{t('periph.tilt.recenter')}</button></div>
            </>
          ) : state === 'denied' || state === 'none' || !supported ? (
            <>
              <p>{state === 'denied' ? t('periph.tilt.denied') : t('periph.tilt.none')}</p>
              {state === 'denied' && <div className="cd-acts"><button className="cd-btn" onClick={use}>{t('periph.tilt.retry')}</button></div>}
            </>
          ) : (
            <>
              <p>{t('periph.tilt.ask')}</p>
              <div className="cd-acts">
                <button className="cd-btn y" disabled={state !== 'off'} onClick={use}>{state === 'off' ? t('periph.tilt.useMotion') : t('periph.tilt.waiting')}</button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
