import { useEffect, useId, useRef, type ReactNode } from 'react';
import { trapTab } from '../../lib/ui';
import { useT } from '../../i18n';

export interface ConfirmRequest { title: string; body: ReactNode; ok: string; danger?: boolean; run: () => void }

/** Modal yes/no on the paper dialog. Pass null to close it. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const t = useT();
  useEffect(() => {
    const d = ref.current;
    if (request && d && !d.open) d.showModal();
    if (!request && d?.open) d.close();
  }, [request]);
  return (
    <dialog ref={ref} className="mdlg" aria-labelledby={`${id}t`} aria-describedby={`${id}d`} onClose={onClose} onKeyDown={trapTab} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {request && (
        <div className="in">
          <h2 id={`${id}t`}>{request.title}</h2>
          <p id={`${id}d`}>{request.body}</p>
          <div className="acts">
            <button className="btn line" onClick={onClose}>{t('common.cancel')}</button>
            <button className={`btn ${request.danger ? 'danger' : 'k'}`} autoFocus onClick={() => { request.run(); onClose(); }}>{request.ok}</button>
          </div>
        </div>
      )}
    </dialog>
  );
}
