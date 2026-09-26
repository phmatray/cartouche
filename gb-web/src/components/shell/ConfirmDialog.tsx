import { useEffect, useRef, type ReactNode } from 'react';

export interface ConfirmRequest { title: string; body: ReactNode; ok: string; danger?: boolean; run: () => void }

/** Modal yes/no on the paper dialog. Pass null to close it. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (request && d && !d.open) d.showModal();
    if (!request && d?.open) d.close();
  }, [request]);
  return (
    <dialog ref={ref} className="mdlg" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {request && (
        <div className="in">
          <h2>{request.title}</h2>
          <p>{request.body}</p>
          <div className="acts">
            <button className="btn line" onClick={onClose}>Cancel</button>
            <button className={`btn ${request.danger ? 'danger' : 'k'}`} autoFocus onClick={() => { request.run(); onClose(); }}>{request.ok}</button>
          </div>
        </div>
      )}
    </dialog>
  );
}
