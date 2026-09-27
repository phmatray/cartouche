import { detectLang } from '../../i18n/core';
import { LANG_NAMES, LANGS, useT, type Lang } from '../../i18n';
import { useSettingsStore } from '../../store/settingsStore';
import { Row } from './parts';

/** The interface language: the browser's (Automatic) or one of ours, applied at once. */
export function LanguageTab() {
  const t = useT();
  const { language, set } = useSettingsStore();
  return (
    <>
      <h2>{t('common.language')}</h2>
      <p className="intro">{t('settings.language.intro')}</p>
      <Row label={t('common.language')} sub={t('settings.language.sub')}>
        <label className="sel">
          <select value={language ?? ''} aria-label={t('common.language')} onChange={(e) => set({ language: (e.target.value || null) as Lang | null })}>
            <option value="">{t('settings.language.auto', { name: LANG_NAMES[detectLang()] })}</option>
            {LANGS.map((l) => <option key={l} value={l} lang={l}>{LANG_NAMES[l]}</option>)}
          </select>
        </label>
      </Row>
    </>
  );
}
