import { useRef } from 'react';
import { dismissToast, useToasts, type ToastItem } from './actions';

/** Focus `el`, making a heading or landmark focusable by script first. */
const focusOn = (el: HTMLElement) => {
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.tabIndex = -1;
  el.focus();
};

export function Toasts() {
  const list = useToasts((s) => s.list);
  const prev = useRef<Element | null>(null); // where the focus was before it came to a toast
  // Its action removes the toast, focused button and all: focus goes to what the action opened (the new page's
  // heading, its `target`), else back where it came from, else the page, never to the top of the document.
  const act = (t: ToastItem) => {
    const from = prev.current, path = location.pathname;
    t.action!.run();
    dismissToast(t.id);
    setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return; // the action placed it
      const to = (location.pathname !== path && document.querySelector<HTMLElement>('main h1'))
        || (t.action!.target && document.querySelector<HTMLElement>(t.action!.target))
        || (from instanceof HTMLElement && from.isConnected && from)
        || document.querySelector<HTMLElement>('main');
      if (to) focusOn(to);
    });
  };
  return (
    <div className="toasts" role="status" aria-live="polite" onFocus={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) prev.current = e.relatedTarget; }}>
      {list.map((t) => (
        <div key={t.id} data-id={t.id} className={`toast ${t.tone}${t.badge ? ' ach' : ''}`}>
          {t.badge ? <img src={t.badge} alt="" width={44} height={44} /> : <i />}<span>{t.msg}</span>
          {t.action && <button onClick={() => act(t)}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
