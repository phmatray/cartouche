import { lazy, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { useSettingsStore } from '../../store/settingsStore';
import { cleanLayout, deviceClass, layoutKey, type Layout, type Orient, type Part, type Place } from '../../lib/touch-layout';
import { holdTouches, misfit, useMedia, useSkin } from './touch-dom';
import { toast } from '../shell/actions';
import './touch.css';
import { I } from '../icons';
import { useT } from '../../i18n';

// The editor only loads when the player opens it.
const ControlsEditor = lazy(() => import('./ControlsEditor'));

/** The phone-sideways layout of the player (index.css): D-pad left of the screen, buttons right. */
const LANDSCAPE = '(orientation: landscape) and (max-height: 500px)';

type PadProps = (b: string) => object;
interface Props {
  /** A button's props; 'dpad': the D-pad box's handlers (the whole box is one control, its arms only show what's held). */
  pad: PadProps;
  /** Online link cable: no rewind, no fast-forward. */
  online: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  startRewind: () => void;
  stopRewind: () => void;
  speed: number;
  setSpeed: (s: number) => void;
}

const at = (p: Place | undefined): CSSProperties | undefined => p && ({
  left: `calc(${p.ax * 100}% + ${p.x}px)`, top: `calc(${p.ay * 100}% + ${p.y}px)`, opacity: p.o, '--s': p.s,
} as CSSProperties);

/** The on-screen controls: the skin, the player's own layout for this device and orientation, and its editor. */
export function TouchControls({ pad, online, editing, onEdit, onDone, startRewind, stopRewind, speed, setSpeed }: Props) {
  const t = useT();
  const touchSize = useSettingsStore((s) => s.touchSize);
  const layouts = useSettingsStore((s) => s.touchLayouts);
  const { skin, shell } = useSkin();
  const orient: Orient = useMedia(LANDSCAPE) ? 'landscape' : 'portrait';
  const key = layoutKey(deviceClass(), orient);
  const stored = useMemo(() => cleanLayout(layouts?.[key]), [layouts, key]);
  // The draft belongs to one layout: turning the phone mid-edit starts on the other orientation's own.
  const [drafted, setDrafted] = useState<{ key: string; l: Layout } | null>(null);
  const draft = drafted?.key === key ? drafted.l : null;
  const onDraft = useCallback((l: Layout) => setDrafted({ key, l }), [key]);
  // A layout made on a bigger phone (or imported, or synced) that doesn't fit this one: the skin's layout plays instead.
  const [misfits, setMisfits] = useState<Layout | null>(null);
  const layout = editing ? draft ?? stored : stored === misfits ? null : stored;
  const overlay = !!layout?.overlay;
  const zone = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (editing || !stored || stored === misfits || !zone.current || !misfit(zone.current, stored.overlay)) return;
    setMisfits(stored);
    toast(t('player.touch.misfit'), 'm', { label: t('player.touch.fix'), run: onEdit });
  }, [editing, stored, misfits, onEdit, t]);

  const off = (b: string) => ({ 'data-pad': b });
  const p: PadProps = editing ? off : pad;
  // Hold to fast-forward: the fastest speed while held, then back to the one before.
  const [before, setBefore] = useState<number | null>(null);
  const hold = (down: () => void, up: () => void) => editing ? {} : {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* keep going */ }
      e.currentTarget.classList.add('down');
      if (useSettingsStore.getState().haptics) navigator.vibrate?.(8);
      down();
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => { e.currentTarget.classList.remove('down'); up(); },
    onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => { e.currentTarget.classList.remove('down'); up(); },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
  const ff = hold(() => { setBefore(before ?? speed); setSpeed(4); }, () => { if (before !== null) setSpeed(before); setBefore(null); });
  const parts = { ...layout?.parts };
  if (online) { delete parts.rew; delete parts.ff; }
  const place = (part: Part) => at(parts[part]);

  return (
    <>
    <div className="touch" ref={holdTouches} role="group" data-size={layout ? undefined : touchSize} data-skin={skin} data-shell={skin === 'color' ? shell : undefined} aria-label={t('player.touch.label')}>
      <div className="tz" ref={zone} data-custom={layout ? '' : undefined} data-overlay={overlay ? '' : undefined} data-editing={editing ? '' : undefined}>
        <div className="dpad" data-part="dpad" style={place('dpad')} {...(editing ? {} : pad('dpad'))}>
          <span className="c" />
          <button className="u" aria-label={t('player.touch.up')} {...off('Up')}>{I.up}</button>
          <button className="d" aria-label={t('player.touch.down')} {...off('Down')}>{I.down}</button>
          <button className="l" aria-label={t('player.touch.left')} {...off('Left')}>{I.left}</button>
          <button className="r" aria-label={t('player.touch.right')} {...off('Right')}>{I.right}</button>
        </div>
        <div className="ab" data-part="ab" style={place('ab')}><button className="b" data-l="B" {...p('B')}>B</button><button className="a" data-l="A" {...p('A')}>A</button></div>
        <div className="ss" data-part="ss" style={place('ss')}><button data-l="Select" {...p('Select')}>Select</button><button data-l="Start" {...p('Start')}>Start</button></div>
        {parts.rew && <button className="tx" data-part="rew" style={place('rew')} aria-label={t('player.touch.rewind')} {...hold(startRewind, stopRewind)}>{I.rew}</button>}
        {parts.ff && <button className="tx" data-part="ff" style={place('ff')} aria-label={t('player.touch.ff')} {...ff}>{I.ff}</button>}
      </div>
    </div>
      {editing && (
        <Suspense fallback={null}>
          <ControlsEditor key={key} zone={zone} layout={layout} layoutName={t(`player.edit.${deviceClass()}${orient === 'landscape' ? 'Wide' : 'Tall'}`)}
            onDraft={onDraft}
            onCommit={(l) => useSettingsStore.getState().set({ touchLayouts: { ...useSettingsStore.getState().touchLayouts, [key]: l } })}
            onReset={() => { const rest = { ...useSettingsStore.getState().touchLayouts }; delete rest[key]; useSettingsStore.getState().set({ touchLayouts: rest }); setDrafted(null); }}
            onDone={() => { setDrafted(null); onDone(); }} />
        </Suspense>
      )}
    </>
  );
}
