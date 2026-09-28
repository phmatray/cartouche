import { useSettingsStore } from '../store/settingsStore';
import { Slider } from '../components/settings/parts';
import { useT } from '../i18n';

/** Settings › Controls › Tilt: how strongly tilt reaches MBC7 cartridges. */
export function TiltRows() {
  const t = useT();
  const { tiltSensitivity, set } = useSettingsStore();
  return (
    <>
      <h3>{t('periph.tilt.title')}</h3>
      <Slider label={t('periph.tilt.sensitivity')} sub={t('periph.tilt.sensitivitySub')} value={tiltSensitivity} min={50} max={200} set={(v) => set({ tiltSensitivity: v })} />
    </>
  );
}
