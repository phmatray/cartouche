import { useState } from 'react';
import type { useEmulator } from '../../../hooks/useEmulator';
import { useT } from '../../../i18n';

const LINES = 24;

function hex16(v: number): string {
  return v.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * SM83 code around PC, the current instruction marked. Backward disassembly is ambiguous, so the
 * listing starts at the last anchor at or before PC that still shows it, else at PC itself.
 */
export function Disassembly({ emu, pc }: { emu: ReturnType<typeof useEmulator>; pc: number }) {
  const { disassemble, breakpoints, addBreakpoint, removeBreakpoint } = emu;
  const [anchor, setAnchor] = useState(pc);
  const t = useT();

  let lines = disassemble(anchor, LINES);
  const at = lines.findIndex((l) => l.addr === pc);
  if (anchor > pc || at < 0 || at > LINES - 4) {
    lines = disassemble(pc, LINES);
    if (anchor !== pc) setAnchor(pc);
  }

  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: 0, font: '600 12px/1.5 ui-monospace,Menlo,monospace' }}>
      {lines.map((l) => {
        const on = breakpoints.includes(l.addr);
        return (
          <li key={l.addr} aria-current={l.addr === pc || undefined}
            style={{ display: 'flex', gap: 8, alignItems: 'center', background: l.addr === pc ? 'var(--paper-3)' : undefined }}>
            <button type="button" aria-pressed={on} aria-label={t('player.debug.toggleBreakpoint', { addr: hex16(l.addr) })}
              onClick={() => (on ? removeBreakpoint(l.addr) : addBreakpoint(l.addr))}
              style={{ width: 24, height: 24, border: 0, background: 'none', color: 'var(--err)', cursor: 'pointer' }}>
              {on ? '●' : '○'}
            </button>
            <span style={{ width: 40 }}>{hex16(l.addr)}</span>
            <span style={{ width: 72, opacity: 0.55 }}>{l.bytes}</span>
            <span>{l.text}</span>
          </li>
        );
      })}
    </ol>
  );
}
