import { useEffect } from 'react';
import { LEGAL_SECTIONS } from '../content/legal';

/** Plain text with its URLs turned into links (odd split parts are the URLs). */
const linkify = (text: string) =>
  text.split(/(https?:\/\/[^\s)]*[^\s).,])/).map((part, i) => (i % 2 ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a> : part));

export function LegalPage() {
  useEffect(() => { document.title = 'Legal · Cartouche'; }, []);
  return (
    <main className="wrap">
      <div className="pagehead"><h1>Legal</h1><p>What Cartouche is, what it isn’t, and whose trademarks these are.</p></div>
      <article className="paper sheet-card legal">
        {LEGAL_SECTIONS.map((s) => (
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
