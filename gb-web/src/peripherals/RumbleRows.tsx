import { useEffect, useState } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { Row, Slider, SwitchRow } from '../components/settings/parts';
import { rumbleOutputs, testRumble } from './rumble';

/** Settings › Controls › Rumble: for cartridges with a rumble motor. Says plainly what this device can do. */
export function RumbleRows() {
  const { rumble, rumbleIntensity, rumbleShake, set } = useSettingsStore();
  const [out, setOut] = useState(rumbleOutputs);
  useEffect(() => {
    const update = () => setOut(rumbleOutputs());
    window.addEventListener('gamepadconnected', update);
    window.addEventListener('gamepaddisconnected', update);
    return () => { window.removeEventListener('gamepadconnected', update); window.removeEventListener('gamepaddisconnected', update); };
  }, []);
  const where = out.pad ? 'Your gamepad’s motors rumble.'
    : out.vibrate ? 'This device vibrates (on phones; most computers have no motor). A gamepad with rumble works too.'
    : out.tick ? 'iPhone has no vibration for websites: with iOS 18 or later you feel a light tick on each touch-button press while the motor runs. A gamepad with rumble works fully.'
    : 'No motor found here: connect a gamepad with rumble, or keep the screen shake.';
  return (
    <>
      <h3>Rumble</h3>
      <SwitchRow label="Rumble" sub="For cartridges with a rumble motor" on={rumble} set={(v) => set({ rumble: v })} />
      <Slider label="Strength" value={rumbleIntensity} min={10} max={100} set={(v) => set({ rumbleIntensity: v })} />
      <SwitchRow label="Shake the screen" sub="A small jolt of the screen while the motor runs. Off when your system asks for reduced motion." on={rumbleShake} set={(v) => set({ rumbleShake: v })} />
      <Row label="On this device" sub={where}>
        <button className="sbtn" disabled={!rumble} onClick={() => testRumble(rumbleIntensity)}>Test</button>
      </Row>
    </>
  );
}
