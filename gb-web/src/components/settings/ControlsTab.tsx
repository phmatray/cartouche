import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useSettingsStore, type GameBoyButton, type TouchSize } from '../../store/settingsStore';
import { keyLabel, owned, paths } from '../../lib/ui';
import { useGameLibrary } from '../../hooks/useGameLibrary';
import { ControlsFileRows, SkinPicker } from '../player/TouchSkins';
import { toast } from '../shell/actions';
import { Row, Seg, SwitchRow } from './parts';
import { t as tNow, useT, type Key } from '../../i18n';
import { RumbleRows } from '../../peripherals/RumbleRows';

const BUTTONS: GameBoyButton[] = ['Up', 'Down', 'Left', 'Right', 'A', 'B', 'Start', 'Select'];
/** Keys the player already uses for its own shortcuts. */
const RESERVED: Record<string, Key> = { p: 'shell.keys.pause', r: 'player.deck.rewind', m: 'shell.keys.mute', f: 'shell.keys.fullscreen', F5: 'common.save', F8: 'common.load', F12: 'shell.keys.screenshot', '/': 'shell.keys.search', '?': 'shell.keys.shortcuts', Tab: 'settings.controls.focus', Escape: 'common.cancel' };
// Standard Gamepad layout, as mapped by useGamepad.
const PAD: [string, Key | string][] = [['A', 'settings.controls.padBottom'], ['B', 'settings.controls.padRight'], ['Start', 'Options / Menu'], ['Select', 'Share / View'], ['shell.keys.dpad', 'settings.controls.padDpad'], ['shell.keys.fullscreen', 'settings.controls.padTop']];
const tk = (s: string) => (s.includes('.') ? tNow(s as Key) : s);

const padName = () => {
  const g = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
  return g ? g.id.replace(/\(.*\)/, '').trim() || tNow('player.gamepad') : null;
};

export function ControlsTab() {
  const { keybindings, updateKeybinding, resetKeybindings, touchSize, haptics, set } = useSettingsStore();
  const [listening, setListening] = useState<GameBoyButton | null>(null);
  const [pad, setPad] = useState(padName);
  const t = useT();
  // The layout is edited over a real game: the last one played, else the bundled one.
  const { games } = useGameLibrary();
  const recent = games.filter(owned).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))[0];

  useEffect(() => {
    const update = () => setPad(padName());
    window.addEventListener('gamepadconnected', update);
    window.addEventListener('gamepaddisconnected', update);
    return () => { window.removeEventListener('gamepadconnected', update); window.removeEventListener('gamepaddisconnected', update); };
  }, []);

  useEffect(() => {
    if (!listening) return;
    const capture = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setListening(null); return; }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const clash = BUTTONS.find((b) => b !== listening && keybindings[b].toLowerCase() === key.toLowerCase());
      if (clash) { toast(tNow('settings.controls.clash', { key: keyLabel(key), button: btn(clash) }), 'm'); return; }
      const reserved = RESERVED[key];
      if (reserved) { toast(tNow('settings.controls.reserved', { key: keyLabel(key), action: tNow(reserved) }), 'm'); return; }
      updateKeybinding(listening, key);
      toast(tNow('settings.controls.now', { button: btn(listening), key: keyLabel(key) }), 'c');
      setListening(null);
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, [listening, keybindings, updateKeybinding]);

  // One press wipes a whole custom layout: say so, with a way back.
  const resetKeys = () => {
    const before = keybindings;
    resetKeybindings();
    setListening(null);
    toast(tNow('settings.controls.resetDone'), 'c', { label: tNow('settings.pergame.undo'), run: () => set({ keybindings: before }) });
  };

  return (
    <>
      <h2>{t('settings.tabs.controls')}</h2>
      <p className="intro">{t('settings.controls.intro')}</p>
      <h3>{t('player.controls.keyboard')}</h3>
      <ul className="binds">
        {BUTTONS.map((b) => (
          <li key={b}>
            <span className="btnname">{btn(b)}</span>
            <span className={`key${listening === b ? ' listening' : ''}${keyLabel(keybindings[b]).length > 2 ? ' wide' : ''}`}>{keyLabel(keybindings[b])}</span>
            <span className="leader" />
            <button className="sbtn" aria-label={t('settings.controls.changeFor', { button: btn(b) })} onClick={() => setListening(listening === b ? null : b)}>
              {listening === b ? t('settings.controls.press') : t('link.cart.change')}
            </button>
          </li>
        ))}
      </ul>
      <p style={{ marginTop: 14 }}>
        <button className="btn line" style={{ color: 'var(--ink)' }} onClick={resetKeys}>{t('settings.controls.reset')}</button>
      </p>

      <h3>{t('player.controls.gamepad')}</h3>
      <Row label={pad ?? t('settings.controls.noPad')}
        sub={pad ? t('settings.controls.padOn') : t('settings.controls.padOff')}>
        <span className={`tag ${pad ? 'now' : 'need'}`} style={{ margin: 0 }}>{pad ? t('settings.controls.connected') : t('settings.controls.waiting')}</span>
      </Row>
      <dl className="spec">
        {PAD.map(([a, b]) => <div key={a}><dt>{tk(a)}</dt><dd>{tk(b)}</dd></div>)}
      </dl>

      <h3>{t('player.controls.touch')}</h3>
      <SkinPicker />
      <Row label={t('settings.controls.layout')} sub={t('settings.controls.layoutSub')}>
        <Link className="btn k" to={paths.play(recent?.id ?? 'tobu-tobu-girl', '?edit=controls')}>{t('settings.controls.edit')}</Link>
      </Row>
      <Row label={t('settings.controls.size')} sub={t('settings.controls.sizeSub')}>
        <Seg<TouchSize> label={t('settings.controls.size')} value={touchSize} options={[['S', 'S'], ['M', 'M'], ['L', 'L']]} set={(v) => set({ touchSize: v })} />
      </Row>
      <SwitchRow label={t('settings.controls.vibrate')} sub={t('settings.controls.vibrateSub')} on={haptics} set={(v) => set({ haptics: v })} />

      <RumbleRows />
      <ControlsFileRows />
    </>
  );
}

/** A Game Boy button's name: A, B, Start and Select as printed on the console; the d-pad directions translated. */
function btn(b: GameBoyButton) {
  return b === 'Up' || b === 'Down' || b === 'Left' || b === 'Right' ? tNow(`player.touch.${b.toLowerCase() as 'up'}`) : b;
}
