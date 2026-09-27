import { useSettingsStore } from '../../store/settingsStore';
import { Row, Seg, SwitchRow } from './parts';
import { useT } from '../../i18n';

export function EmulationTab() {
  const s = useSettingsStore();
  const t = useT();
  return (
    <>
      <h2>{t('settings.tabs.emulation')}</h2>
      <p className="intro">{t('settings.emu.intro')}</p>
      <Row label={t('settings.emu.speed')} sub={t('settings.emu.speedSub')}>
        <Seg<number> label={t('settings.emu.speed')} value={s.defaultSpeed} options={[[0.5, '½×'], [1, '1×'], [2, '2×'], [4, '4×']]} set={s.setDefaultSpeed} />
      </Row>
      <Row label={t('settings.emu.rewind')} sub={t('settings.emu.rewindSub')}>
        <span className="range">
          <input type="range" min={5} max={60} step={5} value={s.rewindBufferSeconds} aria-label={t('settings.emu.rewind')} onChange={(e) => s.setRewindBufferSeconds(+e.target.value)} />
          <output>{s.rewindBufferSeconds} s</output>
        </span>
      </Row>
      <h3>{t('settings.emu.progress')}</h3>
      <SwitchRow label={t('settings.emu.resume')} sub={t('settings.emu.resumeSub')} on={s.resumePoints} set={(v) => s.set({ resumePoints: v })} />
      <SwitchRow label={t('settings.emu.auto')} sub={t('settings.emu.autoSub')} on={s.autoSaveEnabled} set={s.setAutoSaveEnabled} />
      <Row label={t('settings.emu.every')}>
        <label className="sel">
          <select value={s.autoSaveIntervalSeconds} disabled={!s.autoSaveEnabled} aria-label={t('settings.emu.every')} onChange={(e) => s.setAutoSaveIntervalSeconds(+e.target.value)}>
            <option value={30}>{t('settings.emu.s30')}</option><option value={60}>{t('settings.emu.m1')}</option><option value={300}>{t('settings.emu.m5')}</option>
          </select>
        </label>
      </Row>
    </>
  );
}
