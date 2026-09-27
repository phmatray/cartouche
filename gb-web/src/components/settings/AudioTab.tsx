import { useSettingsStore, type ChannelMutes } from '../../store/settingsStore';
import { Slider, SwitchRow } from './parts';
import { useT } from '../../i18n';

const CHANNELS: (keyof ChannelMutes)[] = ['pulse1', 'pulse2', 'wave', 'noise'];

export function AudioTab() {
  const { masterVolume, setMasterVolume, channelMutes, toggleChannelMute } = useSettingsStore();
  const t = useT();
  return (
    <>
      <h2>{t('settings.tabs.audio')}</h2>
      <p className="intro">{t('settings.audio.intro')}</p>
      <Slider label={t('settings.audio.volume')} value={masterVolume} min={0} max={100} set={setMasterVolume} />
      <h3>{t('settings.audio.channels')}</h3>
      {CHANNELS.map((k) => <SwitchRow key={k} label={t(`settings.audio.${k}`)} sub={t(`settings.audio.${k}Sub`)} on={!channelMutes[k]} set={() => toggleChannelMute(k)} />)}
    </>
  );
}
