import { useSettingsStore } from '../../store/settingsStore';
import { Row, Seg, SwitchRow } from './parts';

export function EmulationTab() {
  const s = useSettingsStore();
  return (
    <>
      <h2>Emulation</h2>
      <p className="intro">How games run and how your progress is kept.</p>
      <Row label="Default speed" sub="The playback bar can change it while playing">
        <Seg<number> label="Default speed" value={s.defaultSpeed} options={[[0.5, '½×'], [1, '1×'], [2, '2×'], [4, '4×']]} set={s.setDefaultSpeed} />
      </Row>
      <Row label="Rewind length" sub="More seconds use more memory while playing">
        <span className="range">
          <input type="range" min={5} max={60} step={5} value={s.rewindBufferSeconds} aria-label="Rewind length" onChange={(e) => s.setRewindBufferSeconds(+e.target.value)} />
          <output>{s.rewindBufferSeconds} s</output>
        </span>
      </Row>
      <h3>Progress</h3>
      <SwitchRow label="Resume where I left off" sub="Keeps a resume point every time you leave a game" on={s.resumePoints} set={(v) => s.set({ resumePoints: v })} />
      <SwitchRow label="Keep cartridge saves automatically" sub="For games with a battery save. When off, the save is still kept when you leave the game." on={s.autoSaveEnabled} set={s.setAutoSaveEnabled} />
      <Row label="Save cartridge memory every">
        <label className="sel">
          <select value={s.autoSaveIntervalSeconds} disabled={!s.autoSaveEnabled} aria-label="Save cartridge memory every" onChange={(e) => s.setAutoSaveIntervalSeconds(+e.target.value)}>
            <option value={30}>30 seconds</option><option value={60}>1 minute</option><option value={300}>5 minutes</option>
          </select>
        </label>
      </Row>
    </>
  );
}
