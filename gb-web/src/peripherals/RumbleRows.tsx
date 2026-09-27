import { useEffect, useState } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { Row, Slider, SwitchRow } from '../components/settings/parts';
import { useT } from '../i18n';
import { rumbleOutputs, testRumble } from './rumble';

/** Settings › Controls › Rumble: for cartridges with a rumble motor. Says plainly what this device can do. */
export function RumbleRows() {
  const t = useT();
  const { rumble, rumbleIntensity, rumbleShake, set } = useSettingsStore();
  const [out, setOut] = useState(rumbleOutputs);
  useEffect(() => {
    const update = () => setOut(rumbleOutputs());
    window.addEventListener('gamepadconnected', update);
    window.addEventListener('gamepaddisconnected', update);
    return () => { window.removeEventListener('gamepadconnected', update); window.removeEventListener('gamepaddisconnected', update); };
  }, []);
  const where = out.pad ? t('periph.rumble.pad') : out.vibrate ? t('periph.rumble.vibrate') : out.tick ? t('periph.rumble.iphone') : t('periph.rumble.none');
  // The test runs a gamepad or phone motor; with neither (iPhone, most computers) it could only do nothing.
  const testable = out.pad || out.vibrate;
  return (
    <>
      <h3>{t('periph.rumble.title')}</h3>
      <SwitchRow label={t('periph.rumble.on')} sub={t('periph.rumble.onSub')} on={rumble} set={(v) => set({ rumble: v })} />
      <Slider label={t('periph.rumble.strength')} value={rumbleIntensity} min={10} max={100} set={(v) => set({ rumbleIntensity: v })} />
      <SwitchRow label={t('periph.rumble.shake')} sub={t('periph.rumble.shakeSub')} on={rumbleShake} set={(v) => set({ rumbleShake: v })} />
      <Row label={t('periph.rumble.here')} sub={where}>
        {testable ? <button className="sbtn" disabled={!rumble} onClick={() => testRumble(rumbleIntensity)}>{t('periph.rumble.test')}</button> : null}
      </Row>
    </>
  );
}
