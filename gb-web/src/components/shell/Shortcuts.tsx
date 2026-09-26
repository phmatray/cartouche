import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store/settingsStore';
import { keyLabel } from '../../lib/ui';

/** Every keyboard shortcut, with the game keys as currently bound in Settings. */
export function ShortcutsList() {
  const k = useSettingsStore((s) => s.keybindings);
  const rows: [string, string[]][] = [
    ['Search', ['/']], ['Shortcuts', ['?']], ['D-pad', [k.Up, k.Down, k.Left, k.Right].map(keyLabel)], ['A / B', [keyLabel(k.A), keyLabel(k.B)]],
    ['Start / Select', [keyLabel(k.Start), keyLabel(k.Select)]], ['Pause', ['P']], ['Rewind (hold)', ['R']], ['Save slot 1', ['F5']],
    ['Load slot 1', ['F8']], ['Screenshot', ['F12']], ['Mute', ['M']], ['Fullscreen', ['F']],
  ];
  return (
    <div className="shortcuts">
      {rows.map(([a, ks]) => <div key={a}><span>{a}</span><span className="keys">{ks.map((x, i) => <span key={i} className="key">{x}</span>)}</span></div>)}
    </div>
  );
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (open && d && !d.open) d.showModal();
    if (!open && d?.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="mdlg wide" aria-labelledby="h-keys" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="in">
        <h2 id="h-keys">Keyboard shortcuts</h2>
        <ShortcutsList />
        <div className="acts" style={{ marginTop: 22 }}><button className="btn k" onClick={onClose}>Done</button></div>
      </div>
    </dialog>
  );
}
