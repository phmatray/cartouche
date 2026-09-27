import { useEffect } from 'react';
import { LEGAL_SECTIONS } from '../content/legal';
import { LEGAL_FR } from '../content/legal.fr';
import { LEGAL_ES } from '../content/legal.es';
import { useLang, useT } from '../i18n';

const LEGAL = { en: LEGAL_SECTIONS, fr: LEGAL_FR, es: LEGAL_ES };

/** Plain text with its URLs turned into links (odd split parts are the URLs). */
const linkify = (text: string) =>
  text.split(/(https?:\/\/[^\s)]*[^\s).,])/).map((part, i) => (i % 2 ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a> : part));

export function LegalPage() {
  const t = useT();
  const lang = useLang();
  useEffect(() => { document.title = t('common.docTitle', { page: t('shell.legal') }); }, [t]);
  return (
    <main className="wrap">
      <div className="pagehead"><h1>{t('shell.legal')}</h1><p>{t('legal.intro')}</p></div>
      <article className="paper sheet-card legal">
        {lang !== 'en' && <p className="note">{t('legal.prevails')}</p>}
        {LEGAL[lang].map((s) => (
          <section key={s.title}>
            <h2>{s.title}</h2><p>{linkify(s.body)}</p>
            {s.links && (
              <ul>
                {s.links.map((l) => <li key={l.file}><a href={import.meta.env.BASE_URL + l.file}>{l.label}</a></li>)}
              </ul>
            )}
          </section>
        ))}
      </article>
    </main>
  );
}
