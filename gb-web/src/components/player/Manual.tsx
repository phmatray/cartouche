import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { GameEntry } from '../../types/game';
import type { StoredSaveState, StoredScreenshot } from '../../lib/db';
import type { RomMetadata } from '../../lib/rom-utils';
import type { useEmulator } from '../../hooks/useEmulator';
import type { SlotKey } from '../../hooks/useSaveStates';
import { useSettingsStore, type ScreenSize } from '../../store/settingsStore';
import { MotionRows, ScreenFilters } from '../settings/ScreenFilters';
import { ago, dur, paths } from '../../lib/ui';
import { I } from '../icons';
import { Frame } from '../library/Heroes';
import { Title } from '../library/Cover';
import { hardwareOf } from '../../hooks/useGameExtras';
import { Shot } from '../game/Shot';
import { DebugPanel } from './DebugPanel';

export type Tab = 'controls' | 'saves' | 'screen' | 'album' | 'game';
// The Codes page of the printed manual is left out until the core can apply cheat codes.
const TABS: [Tab, string, string][] = [['controls', 'Controls', 'p. 4'], ['saves', 'Saves', 'p. 6'], ['screen', 'Screen', 'p. 8'], ['album', 'Album', 'p. 10'], ['game', 'Game', 'p. 12']];

interface ManualProps {
  game: GameEntry;
  header: RomMetadata | null;
  /** The core runs the cartridge in Color mode: palettes don't apply, colour correction does. */
  inColor?: boolean;
  tab: Tab;
  onTab: (t: Tab) => void;
  romLoaded: boolean;
  isRunning: boolean;
  states: (StoredSaveState | undefined)[];
  shots: StoredScreenshot[];
  emu: ReturnType<typeof useEmulator>;
  onSave: (slot: number) => void;
  onLoad: (k: SlotKey) => void;
  onScreenshot: () => void;
}

/** The paper manual beside the screen (a bottom sheet on phones). */
export function Manual(p: ManualProps) {
  const tab = TABS.some(([k]) => k === p.tab) ? p.tab : 'controls';
  const page: Record<Tab, () => ReactNode> = {
    controls: () => <ControlsPage />,
    saves: () => <SavesPage {...p} />,
    screen: () => <ScreenPage snapshot={p.emu.framebufferSnapshot} romLoaded={p.romLoaded} inColor={!!p.inColor} gameId={p.game.id} />,
    album: () => <AlbumPage {...p} />,
    game: () => <GamePageTab {...p} />,
  };
  return (
    <aside className="sheet" id="sheet" aria-label="Manual">
      <div className="tabs" role="tablist" style={{ gridTemplateColumns: 'repeat(5,minmax(64px,1fr))' }}>
        {TABS.map(([k, t, pg]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => p.onTab(k)}>{t}<small>{pg}</small></button>
        ))}
      </div>
      <section className="page on" role="tabpanel">{page[tab]()}</section>
    </aside>
  );
}

const ARROWS: Record<string, ReactNode> = { ArrowUp: I.up, ArrowDown: I.down, ArrowLeft: I.left, ArrowRight: I.right, ' ': 'Space' };
const Key = ({ k }: { k: string }) => (
  <span className={`key${k.length > 2 && !k.startsWith('Arrow') ? ' wide' : ''}`}>{ARROWS[k] ?? (k.length === 1 ? k.toUpperCase() : k)}</span>
);
const Wide = ({ children }: { children: ReactNode }) => <span className="key wide">{children}</span>;
const Round = ({ children }: { children: ReactNode }) => <span className="key round">{children}</span>;

function ControlsPage() {
  const k = useSettingsStore((s) => s.keybindings);
  const [input, setInput] = useState<'Keyboard' | 'Gamepad' | 'Touch'>('Keyboard');
  const map: Record<typeof input, [ReactNode, string, string?][]> = {
    Keyboard: [
      [<><Key k={k.Up} /><Key k={k.Down} /><Key k={k.Left} /><Key k={k.Right} /></>, 'D-pad'],
      [<Key k={k.A} />, 'A'], [<Key k={k.B} />, 'B'], [<Key k={k.Start} />, 'Start'], [<Key k={k.Select} />, 'Select'],
      [<Key k="R" />, 'Rewind', 'hold'], [<><Key k="F5" /><Key k="F8" /></>, 'Save / Load', 'slot 1'], [<Key k="F12" />, 'Screenshot'],
      [<Key k="P" />, 'Pause'], [<Key k="M" />, 'Mute'], [<Key k="F" />, 'Fullscreen'],
    ],
    Gamepad: [
      [<><Wide>D-pad</Wide><Wide>L-stick</Wide></>, 'D-pad'], [<Round>↓</Round>, 'A', 'bottom face button'], [<Round>→</Round>, 'B', 'right face button'],
      [<Wide>Menu</Wide>, 'Start', 'Options / Menu'], [<Wide>View</Wide>, 'Select', 'Share / View'], [<Round>↑</Round>, 'Fullscreen', 'top face button'],
    ],
    Touch: [
      [<Wide>Cross</Wide>, 'D-pad', 'bottom left'], [<Round>A</Round>, 'A'], [<Round>B</Round>, 'B'], [<Wide>Start</Wide>, 'Start'], [<Wide>Select</Wide>, 'Select'],
    ],
  };
  return (
    <>
      <h2>Controls</h2>
      <p>Change any key in <Link to="/settings/controls">Settings</Link>. A connected gamepad works right away.</p>
      <div className="seg" role="group" aria-label="Input" style={{ marginBottom: 18 }}>
        {(['Keyboard', 'Gamepad', 'Touch'] as const).map((m) => <button key={m} aria-pressed={input === m} onClick={() => setInput(m)}>{m}</button>)}
      </div>
      <ul className="map">
        {map[input].map(([keys, name, sub]) => (
          <li key={name}><span className="keys">{keys}</span><span className="leader" /><span className="btnname">{name}{sub && <small>{sub}</small>}</span></li>
        ))}
      </ul>
    </>
  );
}

const Thumb = ({ s, label }: { s?: StoredSaveState; label: string }) => (s?.thumbnail.length ? <Frame rgba={s.thumbnail} label={label} /> : <>Empty</>);

function SavesPage({ header, states, romLoaded, onSave, onLoad }: ManualProps) {
  const auto = states[0];
  const battery = !!header && /BATTERY/i.test(header.cartridgeType);
  return (
    <>
      <h2>Saves</h2>
      <p>{battery ? 'The cartridge’s own save is kept automatically. ' : ''}The resume point is updated every time you leave.</p>
      <ul className="slots">
        <li>
          <span className="n auto">Auto</span>
          <span className="th"><Thumb s={auto} label="Resume point" /></span>
          <span className="when">{auto ? 'Resume point' : 'No resume point'}<small>{auto ? ago(auto.timestamp) : 'Saved when you leave'}</small></span>
          <span className="act"><button className="sbtn" disabled={!auto || !romLoaded} onClick={() => onLoad('auto')}>Load</button></span>
        </li>
        {Array.from({ length: 5 }, (_, i) => {
          const s = states[i + 1];
          return (
            <li key={i}>
              <span className="n">{i + 1}</span>
              <span className="th"><Thumb s={s} label={`Slot ${i + 1}`} /></span>
              <span className="when">{s ? ago(s.timestamp) : 'Empty slot'}{s && <small>{new Date(s.timestamp).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</small>}</span>
              <span className="act">
                <button className="sbtn" disabled={!romLoaded} onClick={() => onSave(i)}>Save</button>
                <button className="sbtn" disabled={!s || !romLoaded} onClick={() => onLoad(i)}>Load</button>
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function ScreenPage({ snapshot, romLoaded, inColor, gameId }: { snapshot: () => Uint8Array | null; romLoaded: boolean; inColor: boolean; gameId: string }) {
  const { screenSize, setScreenSize } = useSettingsStore();
  const grab = useRef(() => null as Uint8ClampedArray | null);
  useEffect(() => { grab.current = () => { const s = romLoaded ? snapshot() : null; return s ? new Uint8ClampedArray(s) : null; }; });
  const [frame, setFrame] = useState<Uint8ClampedArray | null>(() => { const s = romLoaded ? snapshot() : null; return s ? new Uint8ClampedArray(s) : null; });
  useEffect(() => {
    const t = window.setInterval(() => setFrame(grab.current()), 1000); // live previews, once a second
    return () => window.clearInterval(t);
  }, []);
  return (
    <>
      <h2>Screen</h2>
      <p>Pick the handheld you remember, then fine-tune it. {inColor ? 'Game Boy Color' : 'Original Game Boy'} games share these settings unless one has its own.</p>
      {inColor && (
        <div className="notice"><span className="ic">i</span><span>This is a Game Boy Color game: it keeps its own colors, so palettes don’t apply. Color correction does.</span></div>
      )}
      <ScreenFilters kind={inColor ? 'cgb' : 'dmg'} gameId={gameId} frame={frame} />
      <h3>Motion</h3>
      <MotionRows />
      <h3>Size</h3>
      <div className="seg" role="group" aria-label="Scale">
        {(['fit', '2', '3', '4'] as ScreenSize[]).map((s) => <button key={s} aria-pressed={screenSize === s} onClick={() => setScreenSize(s)}>{s === 'fit' ? 'Fit' : `${s}×`}</button>)}
      </div>
    </>
  );
}

function AlbumPage({ game, shots, romLoaded, onScreenshot }: ManualProps) {
  const file = (s: StoredScreenshot) => `${game.id}-${new Date(s.timestamp).toISOString().replace(/[:.]/g, '-')}.png`;
  const download = (s: StoredScreenshot) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(s.png);
    a.download = file(s);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <>
      <h2>Album</h2>
      <p>Screenshots are saved as 160 × 144 PNGs at original resolution.</p>
      <button className="btn k" style={{ marginBottom: 20 }} disabled={!romLoaded} onClick={onScreenshot}>{I.cam}Take screenshot</button>
      {shots.length ? (
        <div className="albumg">
          {shots.map((s) => (
            <figure key={s.id}>
              <Shot png={s.png} label={`Screenshot, ${ago(s.timestamp)}`} />
              <figcaption><span>{ago(s.timestamp)}</span><span><button className="sbtn" onClick={() => download(s)}>Save PNG</button></span></figcaption>
            </figure>
          ))}
        </div>
      ) : <div className="empty-inline">Nothing here yet. Press F12 while playing.</div>}
    </>
  );
}

function GamePageTab({ game, header, emu, isRunning }: ManualProps) {
  const [debug, setDebug] = useState(false);
  const rows: [string, ReactNode][] = [
    ['Developer', game.developer || '—'], ['Year', game.year || '—'],
    ['Hardware', header ? hardwareOf(header) : '—'], ['Mapper', header?.cartridgeType || '—'],
    ['ROM', header?.romSize || '—'], ['Save memory', header?.ramSize || '—'],
    ['Played', dur(game.totalPlayTime)], ['Sessions', game.sessions ?? 0],
  ];
  return (
    <>
      <h2><Title text={game.title} /></h2>
      {game.description && <p>{game.description}</p>}
      <dl className="spec" style={{ gridTemplateColumns: '1fr' }}>
        {rows.map(([a, b]) => <div key={a}><dt>{a}</dt><dd>{b}</dd></div>)}
      </dl>
      <p style={{ marginTop: 20 }}><Link className="btn line" to={paths.game(game.id)} style={{ color: 'var(--ink)' }}>Open game page</Link></p>
      <div className="row">
        <span>Debug<small>Registers, memory, serial output and tiles, for development</small></span>
        <button className="switch" role="switch" aria-checked={debug} aria-label="Debug" onClick={() => setDebug(!debug)} />
      </div>
      {debug && <DebugPanel emu={emu} isRunning={isRunning} />}
    </>
  );
}
