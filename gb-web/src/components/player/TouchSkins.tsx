import { useSettingsStore } from '../../store/settingsStore';
import { exportControls, importControls, SHELLS, SKINS } from '../../lib/touch-layout';
import { useSkin } from './touch-dom';
import { toast } from '../shell/actions';
import { FileButton } from '../shell/FileButton';
import { download } from '../../lib/ui';
import { Row } from '../settings/parts';
import { t as tNow, useT } from '../../i18n';
import './touch.css';

/** A skin in miniature, in its own inks (touch.css). */
const Swatch = () => (
  <svg viewBox="0 0 120 64" aria-hidden="true">
    <path d="M26 12h12v12h12v12H38v12H26V36H14V24h12z" fill="var(--tc-pad)" stroke="var(--tc-line,none)" />
    <circle cx="86" cy="36" r="9" fill="var(--tc-ab)" stroke="var(--tc-line,none)" />
    <circle cx="103" cy="25" r="9" fill="var(--tc-ab)" stroke="var(--tc-line,none)" />
    <rect x="47" y="51" width="11" height="5" rx="2.5" fill="var(--tc-ss)" stroke="var(--tc-ss-line)" />
    <rect x="62" y="51" width="11" height="5" rx="2.5" fill="var(--tc-ss)" stroke="var(--tc-ss-line)" />
  </svg>
);

/** Pick the skin of the touch controls (and the shell colour of the Color skin). */
export function SkinPicker() {
  const t = useT();
  const { skin, shell } = useSkin();
  const set = useSettingsStore((s) => s.set);
  return (
    <>
      <div className="skins" role="group" aria-label={t('settings.controls.skin')}>
        {SKINS.map((k) => (
          <button key={k} type="button" className="skin" data-skin={k} data-shell={k === 'color' ? shell : undefined} aria-pressed={skin === k} onClick={() => set({ touchSkin: k })}>
            <Swatch /><span>{t(`settings.controls.skins.${k}`)}</span>
          </button>
        ))}
      </div>
      {skin === 'color' && (
        <Row label={t('settings.controls.shell')} sub={t(`settings.controls.shells.${shell}`)}>
          <div className="shells" role="group" aria-label={t('settings.controls.shell')}>
            {SHELLS.map((s) => (
              <button key={s} type="button" data-shell={s} aria-pressed={shell === s} aria-label={t(`settings.controls.shells.${s}`)} title={t(`settings.controls.shells.${s}`)} onClick={() => set({ touchShell: s })}><i /></button>
            ))}
          </div>
        </Row>
      )}
    </>
  );
}

/** Settings › Controls: the skin and every layout to a small .json file, and back. */
export function ControlsFileRows() {
  const t = useT();
  const save = () => {
    const s = useSettingsStore.getState();
    const f = new File([exportControls({ skin: s.touchSkin, shell: s.touchShell, layouts: s.touchLayouts })], 'cartouche-controls.json', { type: 'application/json' });
    // The installed iPhone app previews a downloaded file instead of saving it: the share sheet can save it to Files.
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [f] })) {
      navigator.share({ files: [f] }).catch((e: Error) => { if (e.name !== 'AbortError') download(f, f.name); });
    } else download(f, f.name);
  };
  const load = async (f: File) => {
    const got = f.size < 64_000 ? importControls(await f.text()) : null;
    if (!got) { toast(tNow('settings.controls.notControls', { file: f.name }), 'm'); return; }
    const s = useSettingsStore.getState();
    s.set({ touchSkin: got.skin, touchShell: got.shell, touchLayouts: { ...s.touchLayouts, ...got.layouts } });
    toast(tNow('settings.controls.imported'), 'c');
  };
  return (
    <>
      <Row label={t('settings.controls.exportLabel')} sub={t('settings.controls.exportSub')}>
        <button className="btn line" style={{ color: 'var(--ink)' }} onClick={save}>{t('settings.controls.exportBtn')}</button>
      </Row>
      <Row label={t('settings.controls.importLabel')} sub={t('settings.controls.importSub')}>
        <FileButton className="btn line" style={{ color: 'var(--ink)' }} accept=".json,application/json" onFiles={([f]) => load(f)}>{t('settings.controls.importBtn')}</FileButton>
      </Row>
    </>
  );
}
