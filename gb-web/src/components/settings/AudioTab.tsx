import { useSettingsStore, type ChannelMutes } from '../../store/settingsStore';
import { Row, SwitchRow } from './parts';

const CHANNELS: [keyof ChannelMutes, string, string][] = [
  ['pulse1', 'Pulse 1', 'Square wave with sweep: lead melodies'],
  ['pulse2', 'Pulse 2', 'Square wave: harmony'],
  ['wave', 'Wave', 'Custom waveform: bass lines'],
  ['noise', 'Noise', 'Drums and effects'],
];

export function AudioTab() {
  const { masterVolume, setMasterVolume, channelMutes, toggleChannelMute, muteWhenHidden, set } = useSettingsStore();
  return (
    <>
      <h2>Audio</h2>
      <p className="intro">The Game Boy has four sound channels. Mute one to hear the others clearly.</p>
      <Row label="Volume">
        <span className="range">
          <input type="range" min={0} max={100} value={masterVolume} aria-label="Volume" onChange={(e) => setMasterVolume(+e.target.value)} />
          <output>{masterVolume}%</output>
        </span>
      </Row>
      <h3>Channels</h3>
      {CHANNELS.map(([k, label, sub]) => <SwitchRow key={k} label={label} sub={sub} on={!channelMutes[k]} set={() => toggleChannelMute(k)} />)}
      <h3>Behavior</h3>
      <SwitchRow label="Mute when the tab is hidden" sub="Sound stops when you switch tabs or windows" on={muteWhenHidden} set={(v) => set({ muteWhenHidden: v })} />
    </>
  );
}
