import { useBoxArtProgress } from '../../lib/cover-art';
import { dismissToast, useToasts } from './actions';

export function Toasts() {
  const list = useToasts((s) => s.list);
  const art = useBoxArtProgress();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {art.of > 0 && <div className="toast c"><i /><span>Fetching box art · {art.n} of {art.of}</span></div>}
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <i /><span>{t.msg}</span>
          {t.action && <button onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
