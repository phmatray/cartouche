import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store/settingsStore';
import { keyLabel } from '../../lib/ui';
import { useT, type Key } from '../../i18n';

/** Every keyboard shortcut, with the game keys as currently bound in Settings. */
export function ShortcutsList() {
  const k = useSettingsStore((s) => s.keybindings);
  const t = useT();
  const rows: [Key | string, string[]][] = [
    ['shell.keys.search', ['/']], ['shell.keys.shortcuts', ['?']], ['shell.keys.dpad', [k.Up, k.Down, k.Left, k.Right].map(keyLabel)], ['A / B', [keyLabel(k.A), keyLabel(k.B)]],
    ['Start / Select', [keyLabel(k.Start), keyLabel(k.Select)]], ['shell.keys.pause', ['P']], ['shell.keys.rewind', ['R']], ['shell.keys.save', ['F5']],
    ['shell.keys.load', ['F8']], ['shell.keys.screenshot', ['F12']], ['shell.keys.mute', ['M']], ['shell.keys.fullscreen', ['F']],
  ];
  return (
    <div className="shortcuts">
      {rows.map(([a, ks]) => <div key={a}><span>{a.startsWith('shell.') ? t(a as Key) : a}</span><span className="keys">{ks.map((x, i) => <span key={i} className="key">{x}</span>)}</span></div>)}
    </div>
  );
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();
  useEffect(() => {
    const d = ref.current;
    if (open && d && !d.open) d.showModal();
    if (!open && d?.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="mdlg wide" aria-labelledby="h-keys" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="in">
        <h2 id="h-keys">{t('shell.shortcuts')}</h2>
        <ShortcutsList />
        <div className="acts" style={{ marginTop: 22 }}><button className="btn k" onClick={onClose}>{t('common.done')}</button></div>
      </div>
    </dialog>
  );
}
