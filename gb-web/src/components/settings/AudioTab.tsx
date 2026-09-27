import { useSettingsStore, type ChannelMutes } from '../../store/settingsStore';
import { Row, SwitchRow } from './parts';
import { pct, useT } from '../../i18n';

const CHANNELS: (keyof ChannelMutes)[] = ['pulse1', 'pulse2', 'wave', 'noise'];

export function AudioTab() {
  const { masterVolume, setMasterVolume, channelMutes, toggleChannelMute, muteWhenHidden, set } = useSettingsStore();
  const t = useT();
  return (
    <>
      <h2>{t('settings.tabs.audio')}</h2>
      <p className="intro">{t('settings.audio.intro')}</p>
      <Row label={t('settings.audio.volume')}>
        <span className="range">
          <input type="range" min={0} max={100} value={masterVolume} aria-label={t('settings.audio.volume')} aria-valuetext={pct(masterVolume)} onChange={(e) => setMasterVolume(+e.target.value)} />
          <output>{pct(masterVolume)}</output>
        </span>
      </Row>
      <h3>{t('settings.audio.channels')}</h3>
      {CHANNELS.map((k) => <SwitchRow key={k} label={t(`settings.audio.${k}`)} sub={t(`settings.audio.${k}Sub`)} on={!channelMutes[k]} set={() => toggleChannelMute(k)} />)}
      <h3>{t('settings.audio.behavior')}</h3>
      <SwitchRow label={t('settings.audio.hidden')} sub={t('settings.audio.hiddenSub')} on={muteWhenHidden} set={(v) => set({ muteWhenHidden: v })} />
    </>
  );
}
