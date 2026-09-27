import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { useGameLibrary } from '../../hooks/useGameLibrary';
import { answerBoxArt, fetchBoxArtFor, NO_COVERS, useBoxArtPrompt } from '../../lib/cover-art';
import { toast } from './actions';
import { trapTab } from '../../lib/ui';
import { useSettingsStore } from '../../store/settingsStore';
import { rich, t as tNow, useT } from '../../i18n';

const GITHUB_PRIVACY = 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement';

/**
 * "Show box art?": asked once on first launch (and again only when the player turns box art on
 * without having said yes). Escape, like "Continue without", answers no. Not opened by itself on
 * /legal, which explains it: the question then waits for the next page.
 */
export function BoxArtDialog() {
  const unanswered = useSettingsStore((s) => s.boxArtAnswer === null);
  const asked = useBoxArtPrompt((s) => s.open);
  const games = useGameLibrary().games;
  const onLegal = useLocation().pathname === '/legal';
  const open = asked || (unanswered && !onLegal);
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();
  const back = useRef<HTMLElement | null>(null); // focused before opening, focused again on close

  useEffect(() => {
    const d = ref.current;
    if (open && d && !d.open) {
      back.current = document.activeElement as HTMLElement | null;
      d.showModal();
      d.querySelector<HTMLElement>('.acts button')?.focus(); // "Continue without", not the first link
    }
    if (!open && d?.open) d.close();
  }, [open]);

  const yes = async () => {
    answerBoxArt(true);
    const n = await fetchBoxArtFor(games.filter((g) => g.isLocal));
    toast(n ? tNow('shell.art.ready', { count: n }) : NO_COVERS(), 'c');
  };
  // Closed some other way (Escape): the same as "Continue without".
  const onClose = () => {
    if (useBoxArtPrompt.getState().open || useSettingsStore.getState().boxArtAnswer === null) answerBoxArt(false);
    back.current?.focus();
  };

  return (
    <dialog ref={ref} className="mdlg artdlg" aria-labelledby="boxart-t" aria-describedby="boxart-d" onClose={onClose} onKeyDown={trapTab}>
      {open && (
        <>
          <span className="bar" aria-hidden="true"><i /><i /><i /></span>
          <div className="in">
            <h2 id="boxart-t">{t('shell.art.title')}</h2>
            <div id="boxart-d">
              <p>{t('shell.art.p1')}</p>
              <p>{rich(t('shell.art.p2'), { a: (s) => <a href={GITHUB_PRIVACY} target="_blank" rel="noreferrer">{s}</a> })}</p>
            </div>
            <div className="acts">
              <button className="btn line" onClick={() => answerBoxArt(false)}>{t('shell.art.no')}</button>
              <button className="btn k" onClick={yes}>{t('shell.art.yes')}</button>
            </div>
          </div>
        </>
      )}
    </dialog>
  );
}
