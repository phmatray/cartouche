import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { GameEntry } from '../../types/game';
import type { StoredSaveState, StoredScreenshot } from '../../lib/db';
import { sgbCartOf, type RomMetadata } from '../../lib/rom-utils';
import type { useEmulator } from '../../hooks/useEmulator';
import type { SlotKey } from '../../hooks/useSaveStates';
import { machineFor, useSettingsStore, type Machine, type ScreenSize, type SgbCart } from '../../store/settingsStore';
import { ConsoleRows, MotionRows, ScreenFilters } from '../settings/ScreenFilters';
import { ago, dur, keyLabel, paths } from '../../lib/ui';
import { I } from '../icons';
import { Frame } from '../library/Heroes';
import { Title } from '../library/Cover';
import { hardwareOf } from '../../hooks/useGameExtras';
import { Shot } from '../game/Shot';
import { DebugPanel } from './DebugPanel';
import { SkinPicker } from './TouchSkins';
import { date, rich, useT, type Key } from '../../i18n';
import { descOf } from '../../lib/catalog-utils';
import { raShown } from '../../lib/retroachievements';

const Achievements = lazy(() => import('../game/Achievements'));

const PrintsSection = lazy(() => import('../../peripherals/PrintsSection'));

export type Tab = 'controls' | 'saves' | 'screen' | 'album' | 'game';
// The Codes page of the printed manual is left out until the core can apply cheat codes.
const TABS: [Tab, Key, number][] = [['controls', 'player.tabs.controls', 4], ['saves', 'player.tabs.saves', 6], ['screen', 'player.tabs.screen', 8], ['album', 'player.tabs.album', 10], ['game', 'player.tabs.game', 12]];

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
  /** Online link cable plugged in: rewind and state loading are off. */
  online?: boolean;
  /** The console the game was switched on with (null: not yet). */
  running: Machine | null;
  onRestart: () => void;
  /** Open the touch controls' layout editor. */
  onEditControls: () => void;
}

/** The paper manual beside the screen (a bottom sheet on phones). */
export function Manual(p: ManualProps) {
  const t = useT();
  const tab = TABS.some(([k]) => k === p.tab) ? p.tab : 'controls';
  const page: Record<Tab, () => ReactNode> = {
    controls: () => <ControlsPage online={p.online} onEdit={p.onEditControls} />,
    saves: () => <SavesPage {...p} />,
    screen: () => <ScreenPage snapshot={p.emu.framebufferSnapshot} romLoaded={p.romLoaded} inColor={!!p.inColor} gameId={p.game.id}
      dmgCart={p.header?.cgbFlag === 'DMG Only'} sgb={sgbCartOf(p.header)} running={p.running} onRestart={p.onRestart} />,
    album: () => <AlbumPage {...p} />,
    game: () => <GamePageTab {...p} />,
  };
  return (
    <aside className="sheet" id="sheet" aria-label={t('player.manual')}>
      <div className="tabs" role="tablist">
        {TABS.map(([k, label, pg]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => p.onTab(k)}>{t(label)}<small>{t('player.page', { n: String(pg) })}</small></button>
        ))}
      </div>
      <section className="page on" role="tabpanel">{page[tab]()}</section>
    </aside>
  );
}

const ARROWS: Record<string, ReactNode> = { ArrowUp: I.up, ArrowDown: I.down, ArrowLeft: I.left, ArrowRight: I.right };
const Cap = ({ k }: { k: string }) => (
  <span className={`key${k.length > 2 && !k.startsWith('Arrow') ? ' wide' : ''}`}>{ARROWS[k] ?? (k.length === 1 && k !== ' ' ? k.toUpperCase() : keyLabel(k))}</span>
);
const Wide = ({ children }: { children: ReactNode }) => <span className="key wide">{children}</span>;
const Round = ({ children }: { children: ReactNode }) => <span className="key round">{children}</span>;

function ControlsPage({ online, onEdit }: { online?: boolean; onEdit: () => void }) {
  const k = useSettingsStore((s) => s.keybindings);
  const t = useT();
  const [input, setInput] = useState<'keyboard' | 'gamepad' | 'touch'>('keyboard');
  const dpad = t('shell.keys.dpad');
  const map: Record<typeof input, [ReactNode, string, string?][]> = {
    keyboard: [
      [<><Cap k={k.Up} /><Cap k={k.Down} /><Cap k={k.Left} /><Cap k={k.Right} /></>, dpad],
      [<Cap k={k.A} />, 'A'], [<Cap k={k.B} />, 'B'], [<Cap k={k.Start} />, 'Start'], [<Cap k={k.Select} />, 'Select'],
      ...(online ? [[<Cap k="F5" />, t('common.save'), t('player.controls.slot1')] satisfies [ReactNode, string, string]]
        : [[<Cap k="R" />, t('player.deck.rewind'), t('player.controls.hold')], [<><Cap k="F5" /><Cap k="F8" /></>, t('player.controls.saveLoad'), t('player.controls.slot1')]] satisfies [ReactNode, string, string][]),
      [<Cap k="F12" />, t('shell.keys.screenshot')],
      [<Cap k="P" />, t('shell.keys.pause')], [<Cap k="M" />, t('shell.keys.mute')], [<Cap k="F" />, t('shell.keys.fullscreen')],
    ],
    gamepad: [
      [<><Wide>{dpad}</Wide><Wide>{t('player.controls.lstick')}</Wide></>, dpad], [<Round>↓</Round>, 'A', t('player.controls.bottom')], [<Round>→</Round>, 'B', t('player.controls.right')],
      [<Wide>Menu</Wide>, 'Start', 'Options / Menu'], [<Wide>View</Wide>, 'Select', 'Share / View'], [<Round>↑</Round>, t('shell.keys.fullscreen'), t('player.controls.top')],
    ],
    touch: [
      [<Wide>{t('player.controls.cross')}</Wide>, dpad, t('player.controls.bottomLeft')], [<Round>A</Round>, 'A'], [<Round>B</Round>, 'B'], [<Wide>Start</Wide>, 'Start'], [<Wide>Select</Wide>, 'Select'],
    ],
  };
  return (
    <>
      <h2>{t('player.tabs.controls')}</h2>
      <p>{rich(t('player.controls.intro'), { a: (s) => <Link to="/settings/controls">{s}</Link> })}</p>
      <div className="seg" role="group" aria-label={t('player.controls.input')} style={{ marginBottom: 18 }}>
        {(['keyboard', 'gamepad', 'touch'] as const).map((m) => <button key={m} aria-pressed={input === m} onClick={() => setInput(m)}>{t(`player.controls.${m}`)}</button>)}
      </div>
      <ul className="map">
        {map[input].map(([keys, name, sub]) => (
          <li key={name}><span className="keys">{keys}</span><span className="leader" /><span className="btnname">{name}{sub && <small>{sub}</small>}</span></li>
        ))}
      </ul>
      {input === 'touch' && (
        <>
          <h3>{t('settings.controls.skin')}</h3>
          <SkinPicker />
          <p style={{ marginTop: 18 }}><button className="btn k" onClick={onEdit}>{t('player.controls.editLayout')}</button></p>
        </>
      )}
    </>
  );
}

function Thumb({ s, label }: { s?: StoredSaveState; label: string }) {
  const t = useT();
  return s?.thumbnail.length ? <Frame rgba={s.thumbnail} label={label} /> : <>{t('common.empty')}</>;
}

function SavesPage({ header, states, romLoaded, onSave, onLoad }: ManualProps) {
  const t = useT();
  const auto = states[0];
  const battery = !!header && /BATTERY/i.test(header.cartridgeType);
  return (
    <>
      <h2>{t('player.tabs.saves')}</h2>
      <p>{battery ? `${t('player.saves.battery')} ` : ''}{t('player.saves.resume')}</p>
      <ul className="slots">
        <li>
          <span className="n auto">{t('game.auto')}</span>
          <span className="th"><Thumb s={auto} label={t('game.resumePoint')} /></span>
          <span className="when">{auto ? t('game.resumePoint') : t('player.saves.noResume')}<small>{auto ? ago(auto.timestamp) : t('player.saves.onLeave')}</small></span>
          <span className="act"><button className="sbtn" disabled={!auto || !romLoaded} onClick={() => onLoad('auto')}>{t('common.load')}</button></span>
        </li>
        {Array.from({ length: 5 }, (_, i) => {
          const s = states[i + 1];
          return (
            <li key={i}>
              <span className="n">{i + 1}</span>
              <span className="th"><Thumb s={s} label={t('game.slot', { n: String(i + 1) })} /></span>
              <span className="when">{s ? ago(s.timestamp) : t('player.saves.emptySlot')}{s && <small>{date(s.timestamp, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</small>}</span>
              <span className="act">
                <button className="sbtn" disabled={!romLoaded} onClick={() => onSave(i)}>{t('common.save')}</button>
                <button className="sbtn" disabled={!s || !romLoaded} onClick={() => onLoad(i)}>{t('common.load')}</button>
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function ScreenPage({ snapshot, romLoaded, inColor, gameId, dmgCart, sgb, running, onRestart }: {
  snapshot: () => Uint8Array | null; romLoaded: boolean; inColor: boolean; gameId: string; dmgCart: boolean; sgb: SgbCart; running: Machine | null; onRestart: () => void;
}) {
  const { screenSize, setScreenSize } = useSettingsStore();
  const chosen = useSettingsStore((s) => machineFor(s, gameId, sgb));
  const choosable = dmgCart || !!sgb; // the game can run on another console
  const t = useT();
  const grab = useRef(() => null as Uint8ClampedArray | null);
  useEffect(() => { grab.current = () => { const s = romLoaded ? snapshot() : null; return s ? new Uint8ClampedArray(s) : null; }; });
  const [frame, setFrame] = useState<Uint8ClampedArray | null>(() => { const s = romLoaded ? snapshot() : null; return s ? new Uint8ClampedArray(s) : null; });
  useEffect(() => {
    const t = window.setInterval(() => setFrame(grab.current()), 1000); // live previews, once a second
    return () => window.clearInterval(t);
  }, []);
  return (
    <>
      <h2>{t('player.tabs.screen')}</h2>
      <p>{t(running === 'sgb' ? 'player.screen.introSgb' : inColor ? 'player.screen.introCgb' : 'player.screen.introDmg')}</p>
      {inColor && !dmgCart && running !== 'sgb' && (
        <div className="notice"><span className="ic">i</span><span>{t('player.screen.cgb')}</span></div>
      )}
      {choosable && romLoaded && running !== null && running !== chosen && (
        <div className="notice">
          <span className="ic">i</span>
          <span>{t('player.screen.restartNote')} <button className="sbtn" onClick={onRestart}>{t('player.screen.restart')}</button></span>
        </div>
      )}
      {choosable && <ConsoleRows gameId={gameId} sgb={sgb} />}
      <ScreenFilters kind={inColor ? 'cgb' : 'dmg'} gameId={gameId} frame={frame} />
      <h3>{t('settings.display.motion')}</h3>
      <MotionRows />
      <h3>{t('settings.display.size')}</h3>
      <div className="seg" role="group" aria-label={t('player.screen.scale')}>
        {(['fit', '2', '3', '4'] as ScreenSize[]).map((s) => <button key={s} aria-pressed={screenSize === s} onClick={() => setScreenSize(s)}>{s === 'fit' ? t('settings.display.fit') : `${s}×`}</button>)}
      </div>
    </>
  );
}

function AlbumPage({ game, shots: all, romLoaded, onScreenshot }: ManualProps) {
  const shots = all.filter((s) => s.kind !== 'print');
  const prints = all.filter((s) => s.kind === 'print');
  const t = useT();
  const file = (s: StoredScreenshot) => `${game.id}-${new Date(s.timestamp).toISOString().replace(/[:.]/g, '-')}.png`;
  const download = (s: StoredScreenshot) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(s.png);
    a.download = file(s);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  // Where files can be shared (the iPhone's share sheet: Save Image, Messages…), Share replaces the download.
  const canShare = !!navigator.canShare?.({ files: [new File([], 'shot.png', { type: 'image/png' })] });
  const share = (s: StoredScreenshot) => navigator.share({ files: [new File([s.png], file(s), { type: 'image/png' })] })
    .catch((e) => { if (e?.name !== 'AbortError') download(s); }); // cancelled: nothing
  return (
    <>
      <h2>{t('player.tabs.album')}</h2>
      <p>{t('player.album.intro')}</p>
      <button className="btn k" style={{ marginBottom: 20 }} disabled={!romLoaded} onClick={onScreenshot}>{I.cam}{t('player.album.take')}</button>
      {shots.length ? (
        <div className="albumg">
          {shots.map((s) => (
            <figure key={s.id}>
              <Shot png={s.png} label={t('game.shot', { ago: ago(s.timestamp) })} />
              <figcaption><span>{ago(s.timestamp)}</span><span>{canShare
                ? <button className="sbtn" onClick={() => share(s)}>{t('player.album.share')}</button>
                : <button className="sbtn" onClick={() => download(s)}>{t('player.album.savePng')}</button>}</span></figcaption>
            </figure>
          ))}
        </div>
      ) : <div className="empty-inline">{t('player.album.empty')}</div>}
      {prints.length > 0 && <Suspense fallback={null}><PrintsSection prints={prints} title={game.title} /></Suspense>}
    </>
  );
}

function GamePageTab({ game, header, emu, isRunning }: ManualProps) {
  const [debug, setDebug] = useState(false);
  const t = useT();
  const rows: [string, ReactNode][] = [
    [t('search.facet.developer'), game.developer || '—'], [t('search.facet.year'), game.year || '—'],
    [t('game.cart.hardware'), header ? hardwareOf(header) : '—'], [t('game.cart.mapper'), header?.cartridgeType || '—'],
    ['ROM', header?.romSize || '—'], [t('game.cart.ram'), header?.ramSize === 'None' ? t('common.none') : header?.ramSize || '—'],
    [t('library.col.played'), dur(game.totalPlayTime)], [t('game.sessions'), game.sessions ?? 0],
  ];
  return (
    <>
      <h2><Title text={game.title} /></h2>
      {descOf(game) && <p>{descOf(game)}</p>}
      <dl className="spec" style={{ gridTemplateColumns: '1fr' }}>
        {rows.map(([a, b]) => <div key={a}><dt>{a}</dt><dd>{b}</dd></div>)}
      </dl>
      {raShown(game) && <Suspense><Achievements game={game} /></Suspense>}
      <p style={{ marginTop: 20 }}><Link className="btn line" to={paths.game(game.id)} style={{ color: 'var(--ink)' }}>{t('player.game.open')}</Link></p>
      <div className="row">
        <span>{t('player.game.debug')}<small>{t('player.game.debugSub')}</small></span>
        <button className="switch" role="switch" aria-checked={debug} aria-label={t('player.game.debug')} onClick={() => setDebug(!debug)} />
      </div>
      {debug && <DebugPanel emu={emu} isRunning={isRunning} />}
    </>
  );
}
