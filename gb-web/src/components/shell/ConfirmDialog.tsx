import { useEffect, useId, useRef, type ReactNode } from 'react';
import { keepFocusNear, trapTab } from '../../lib/ui';
import { useT } from '../../i18n';

export interface ConfirmRequest { title: string; body: ReactNode; ok: string; danger?: boolean; run: () => void }

/** Modal yes/no on the paper dialog. Pass null to close it. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const opener = useRef<Element | null>(null);
  const cancel = useRef<HTMLButtonElement>(null), ok = useRef<HTMLButtonElement>(null);
  const t = useT();
  useEffect(() => {
    const d = ref.current;
    if (request && d && !d.open) {
      opener.current = document.activeElement;
      d.showModal(); // focuses the dialog's first control: choose after it (autoFocus would run before, and lose)
      // Destructive: Cancel, so a stray Enter or Space loses nothing. Otherwise the action asked for.
      (request.danger ? cancel : ok).current?.focus();
    }
    if (!request && d?.open) d.close();
    // Confirming often deletes the row the dialog was opened from: keep the focus near it.
    if (!request && opener.current) { keepFocusNear(opener.current); opener.current = null; }
  }, [request]);
  return (
    <dialog ref={ref} className="mdlg" aria-labelledby={`${id}t`} aria-describedby={`${id}d`} onClose={onClose} onKeyDown={trapTab} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {request && (
        <div className="in">
          <h2 id={`${id}t`}>{request.title}</h2>
          <p id={`${id}d`}>{request.body}</p>
          <div className="acts">
            <button ref={cancel} className="btn line" onClick={onClose}>{t('common.cancel')}</button>
            <button ref={ok} className={`btn ${request.danger ? 'danger' : 'k'}`} onClick={() => { request.run(); onClose(); }}>{request.ok}</button>
          </div>
        </div>
      )}
    </dialog>
  );
}
