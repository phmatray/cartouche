import { useEffect, useState } from 'react';
import { useSettingsStore, type GameBoyButton, type TouchSize } from '../../store/settingsStore';
import { keyLabel } from '../../lib/ui';
import { toast } from '../shell/actions';
import { Row, Seg, SwitchRow } from './parts';

const BUTTONS: GameBoyButton[] = ['Up', 'Down', 'Left', 'Right', 'A', 'B', 'Start', 'Select'];
/** Keys the player already uses for its own shortcuts. */
const RESERVED: Record<string, string> = { p: 'Pause', r: 'Rewind', m: 'Mute', f: 'Fullscreen', F5: 'Save', F8: 'Load', F12: 'Screenshot', '/': 'Search', '?': 'Shortcuts', Tab: 'focus', Escape: 'Cancel' };
// Standard Gamepad layout, as mapped by useGamepad.
const PAD: [string, string][] = [['A', 'Bottom face button'], ['B', 'Right face button'], ['Start', 'Options / Menu'], ['Select', 'Share / View'], ['D-pad', 'D-pad or left stick'], ['Fullscreen', 'Top face button']];

const padName = () => {
  const g = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
  return g ? g.id.replace(/\(.*\)/, '').trim() || 'Gamepad' : null;
};

export function ControlsTab() {
  const { keybindings, updateKeybinding, resetKeybindings, touchSize, haptics, set } = useSettingsStore();
  const [listening, setListening] = useState<GameBoyButton | null>(null);
  const [pad, setPad] = useState(padName);

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
      if (clash) { toast(`${keyLabel(key)} is already ${clash}. Pick another key.`, 'm'); return; }
      const reserved = RESERVED[key];
      if (reserved) { toast(`${keyLabel(key)} is kept for ${reserved}. Pick another key.`, 'm'); return; }
      updateKeybinding(listening, key);
      toast(`${listening} is now ${keyLabel(key)}`, 'c');
      setListening(null);
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, [listening, keybindings, updateKeybinding]);

  return (
    <>
      <h2>Controls</h2>
      <p className="intro">Select a button, then press the key you want. Two buttons can’t share a key. Esc cancels.</p>
      <h3>Keyboard</h3>
      <ul className="binds">
        {BUTTONS.map((b) => (
          <li key={b}>
            <span className="btnname">{b}</span>
            <span className={`key${listening === b ? ' listening' : ''}${keyLabel(keybindings[b]).length > 2 ? ' wide' : ''}`}>{keyLabel(keybindings[b])}</span>
            <span className="leader" />
            <button className="sbtn" aria-label={`Change the key for ${b}`} onClick={() => setListening(listening === b ? null : b)}>
              {listening === b ? 'Press a key…' : 'Change'}
            </button>
          </li>
        ))}
      </ul>
      <p style={{ marginTop: 14 }}>
        <button className="btn line" style={{ color: 'var(--ink)' }} onClick={() => { resetKeybindings(); setListening(null); toast('Keys reset to defaults', 'c'); }}>Reset to defaults</button>
      </p>

      <h3>Gamepad</h3>
      <Row label={pad ?? 'No gamepad detected'}
        sub={pad ? 'Connected. The standard layout below is active.' : 'Connect a controller and press any button. Standard layouts (Xbox, PlayStation, Switch Pro) map automatically.'}>
        <span className={`tag ${pad ? 'now' : 'need'}`} style={{ margin: 0 }}>{pad ? 'Connected' : 'Waiting'}</span>
      </Row>
      <dl className="spec" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {PAD.map(([a, b]) => <div key={a}><dt>{a}</dt><dd>{b}</dd></div>)}
      </dl>

      <h3>Touch</h3>
      <Row label="Button size" sub="For phones and tablets">
        <Seg<TouchSize> label="Button size" value={touchSize} options={[['S', 'S'], ['M', 'M'], ['L', 'L']]} set={(v) => set({ touchSize: v })} />
      </Row>
      <SwitchRow label="Vibrate on press" sub="Short buzz when a touch button is pressed" on={haptics} set={(v) => set({ haptics: v })} />
    </>
  );
}
