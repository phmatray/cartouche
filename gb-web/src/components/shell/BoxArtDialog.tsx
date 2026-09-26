import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useLocation } from 'react-router';
import { useGameLibrary } from '../../hooks/useGameLibrary';
import { answerBoxArt, fetchBoxArtFor, useBoxArtPrompt } from '../../lib/cover-art';
import { useSettingsStore } from '../../store/settingsStore';

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

  const yes = () => {
    answerBoxArt(true);
    fetchBoxArtFor(games.filter((g) => g.isLocal));
  };
  // Keep Tab inside the dialog (a modal <dialog> otherwise lets focus leave for the browser's own UI).
  const trap = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const f = [...ref.current!.querySelectorAll<HTMLElement>('a[href],button')];
    const edge = e.shiftKey ? f[0] : f[f.length - 1];
    if (document.activeElement === edge) { e.preventDefault(); (e.shiftKey ? f[f.length - 1] : f[0]).focus(); }
  };
  // Closed some other way (Escape): the same as "Continue without".
  const onClose = () => {
    if (useBoxArtPrompt.getState().open || useSettingsStore.getState().boxArtAnswer === null) answerBoxArt(false);
    back.current?.focus();
  };

  return (
    <dialog ref={ref} className="mdlg artdlg" aria-labelledby="boxart-t" aria-describedby="boxart-d" onClose={onClose} onKeyDown={trap}>
      {open && (
        <>
          <span className="bar" aria-hidden="true"><i /><i /><i /></span>
          <div className="in">
            <h2 id="boxart-t">Show box art?</h2>
            <div id="boxart-d">
              <p>Box art is copyrighted by the game publishers. Cartouche doesn’t host or ship any (only the freely licensed covers of its bundled games).</p>
              <p>
                If you agree, your browser downloads the covers of recognized games you add directly from the libretro-thumbnails
                project on GitHub, so GitHub sees your IP address and browser details (see <a href={GITHUB_PRIVACY} target="_blank" rel="noreferrer">GitHub’s privacy statement</a>),
                and keeps them in this browser’s storage. Nothing is shared with us. You can delete them anytime
                in Settings › Storage.
              </p>
            </div>
            <div className="acts">
              <button className="btn line" onClick={() => answerBoxArt(false)}>Continue without</button>
              <button className="btn k" onClick={yes}>Download box art</button>
            </div>
          </div>
        </>
      )}
    </dialog>
  );
}
