import { useState, useCallback, useEffect } from 'react';
import type { useEmulator } from '../../hooks/useEmulator';
import { useT } from '../../i18n';
import { Disassembly } from './debug/Disassembly';
import { PpuViews } from './debug/PpuViews';
import { FileButton } from '../shell/FileButton';
import { fileAccept } from '../../lib/pwa';
import { parseSym, resolve, type SymTable } from '../../lib/sym';

const NO_SYMS = parseSym('');

function hex8(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, '0');
}

function hex16(v: number): string {
  return v.toString(16).toUpperCase().padStart(4, '0');
}

/** Development aid in the manual's Game page: CPU registers, memory, serial output, and the PPU's tiles, maps, OAM and palettes. */
export function DebugPanel({ emu, isRunning }: { emu: ReturnType<typeof useEmulator>; isRunning: boolean }) {
  const { registers, readMemory, updateRegisters, getSerialOutput, clearSerialOutput,
    setIsRunning, stepInstruction, stepFrame, stepOver, breakReason, breakpoints, addBreakpoint, removeBreakpoint, romBank,
    watchpoints, addWatchpoint, removeWatchpoint, runToScanline } = emu;
  const [bpInput, setBpInput] = useState('');
  const [bpNote, setBpNote] = useState('');
  // Session-only: the symbols of the game being debugged, never stored.
  const [syms, setSyms] = useState<SymTable | null>(null);
  const [wpInput, setWpInput] = useState('');
  const [wpKind, setWpKind] = useState(2);
  const [lineInput, setLineInput] = useState('');
  const [tab, setTab] = useState<'cpu' | 'disasm' | 'serial' | 'tiles' | 'maps' | 'oam' | 'palettes'>('cpu');
  const [memAddr, setMemAddr] = useState(0x0000);
  const [memView, setMemView] = useState<number[]>([]);
  const [serial, setSerial] = useState('');
  const t = useT();

  const refresh = useCallback(() => {
    updateRegisters();
    // A new array on every refresh, so the panel (and PpuViews with it) re-renders each time.
    setMemView(Array.from({ length: 256 }, (_, i) => readMemory((memAddr + i) & 0xffff)));
    setSerial(getSerialOutput());
  }, [updateRegisters, readMemory, memAddr, getSerialOutput]);

  // Live while running (twice a second), once when paused.
  useEffect(() => {
    const first = requestAnimationFrame(refresh);
    const t = isRunning ? window.setInterval(refresh, 500) : 0;
    return () => { cancelAnimationFrame(first); window.clearInterval(t); };
  }, [isRunning, refresh, tab]);

  // A label or a hex address. The core breakpoint is PC-only, so a banked label also stops in other banks: say so.
  const addBp = () => {
    if (!bpInput) return;
    const v = resolve(syms ?? NO_SYMS, bpInput);
    if (v === undefined) { setBpNote(t('player.debug.unknownLabel', { name: bpInput })); return; }
    const sym = syms?.byName.get(bpInput);
    addBreakpoint(v);
    setBpInput('');
    setBpNote(sym && v >= 0x4000 && v < 0x8000 && sym.bank !== romBank()
      ? t('player.debug.otherBank', { name: sym.name, bank: sym.bank, addr: hex16(v) }) : '');
  };
  const loadSyms = (file: File) => file.text().then((text) => setSyms(parseSym(text)));

  const addWp = () => {
    const v = parseInt(wpInput, 16);
    if (/^[0-9a-f]{1,4}$/i.test(wpInput) && v <= 0xffff) { addWatchpoint(v, wpKind); setWpInput(''); }
  };

  const runToLine = () => {
    const ly = Number(lineInput);
    if (/^\d{1,3}$/.test(lineInput) && ly <= 153) { runToScanline(ly); refresh(); }
  };

  const kindName = (k: number) => t(k === 1 ? 'player.debug.watchRead' : k === 2 ? 'player.debug.watchWrite' : 'player.debug.watchAccess');

  const controls = (
    <>
      <div role="group" aria-label={t('player.debug.controls')} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {isRunning
          ? <button className="sbtn" onClick={() => setIsRunning(false)}>{t('player.debug.pause')}</button>
          : <button className="sbtn" onClick={() => setIsRunning(true)}>{t('player.debug.continue')}</button>}
        <button className="sbtn" disabled={isRunning} onClick={() => { stepInstruction(); refresh(); }}>{t('player.debug.step')}</button>
        <button className="sbtn" disabled={isRunning} onClick={() => { stepFrame(); refresh(); }}>{t('player.debug.stepFrame')}</button>
        <button className="sbtn" disabled={isRunning} onClick={() => { stepOver(); refresh(); }}>{t('player.debug.stepOver')}</button>
      </div>
      {breakReason && !isRunning && <p role="status" style={{ margin: '0 0 8px' }}>{t('player.debug.stoppedAt', { reason: breakReason })}</p>}
    </>
  );

  const mono = { font: '600 12px/1.5 ui-monospace,Menlo,monospace' };
  return (
    <div style={{ marginTop: 16 }}>
      {/* Seven views: the settings' wrapping segmented control (three columns in the narrow drawer). */}
      <div className="row col" style={{ border: 0, padding: 0, marginBottom: 14 }}>
        <div className="seg rows" role="group" aria-label={t('player.debug.view')}>
          {(['cpu', 'disasm', 'serial', 'tiles', 'maps', 'oam', 'palettes'] as const).map((v) => <button key={v} aria-pressed={tab === v} onClick={() => setTab(v)}>{t(`player.debug.${v}`)}</button>)}
        </div>
      </div>
      {tab === 'cpu' && (
        <div style={mono}>
          {registers ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4 }}>
                {(['af', 'bc', 'de', 'hl', 'sp', 'pc'] as const).map((r) => <span key={r}>{r.toUpperCase()} <b>{hex16(registers[r])}</b></span>)}
              </div>
              <div style={{ margin: '8px 0 12px' }}>
                {t('player.debug.flags')} {(['z', 'n', 'h', 'c'] as const).map((f) => <b key={f} style={{ opacity: registers.flags[f] ? 1 : 0.25, marginRight: 8 }}>{f.toUpperCase()}</b>)}
              </div>
            </>
          ) : <p>{t('player.debug.noRom')}</p>}
          {controls}
          <form style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }} onSubmit={(e) => { e.preventDefault(); addBp(); }}>
            <label htmlFor="debug-bp">{t('player.debug.breakpoints')}</label>
            <input id="debug-bp" className="field" style={{ width: 140, height: 34 }} value={bpInput} spellCheck={false}
              onChange={(e) => setBpInput(e.target.value.trim())} />
            <button className="sbtn" type="submit">{t('player.debug.addBreakpoint')}</button>
          </form>
          {bpNote && <p role="status" style={{ margin: '0 0 8px' }}>{bpNote}</p>}
          {breakpoints.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {breakpoints.map((a) => (
                <li key={a}>
                  <button className="sbtn" aria-label={t('player.debug.removeBreakpoint', { addr: hex16(a) })} onClick={() => removeBreakpoint(a)}>{hex16(a)} ×</button>
                </li>
              ))}
            </ul>
          )}
          <form style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }} onSubmit={(e) => { e.preventDefault(); addWp(); }}>
            <label htmlFor="debug-wp">{t('player.debug.watchpoints')} 0x</label>
            <input id="debug-wp" className="field" style={{ width: 90, height: 34 }} value={wpInput} maxLength={4}
              onChange={(e) => setWpInput(e.target.value.trim())} />
            <div className="seg" role="group" aria-label={t('player.debug.watchKind')}>
              {[1, 2, 3].map((k) => <button key={k} type="button" aria-pressed={wpKind === k} onClick={() => setWpKind(k)}>{kindName(k)}</button>)}
            </div>
            <button className="sbtn" type="submit">{t('player.debug.addBreakpoint')}</button>
          </form>
          {watchpoints.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {watchpoints.map((w) => (
                <li key={`${w.addr}-${w.kind}`}>
                  <button className="sbtn" aria-label={t('player.debug.removeWatchpoint', { addr: hex16(w.addr), kind: kindName(w.kind) })}
                    onClick={() => removeWatchpoint(w.addr, w.kind)}>{hex16(w.addr)} {kindName(w.kind)} ×</button>
                </li>
              ))}
            </ul>
          )}
          <form style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }} onSubmit={(e) => { e.preventDefault(); runToLine(); }}>
            <input aria-label={t('player.debug.runToLine')} className="field" style={{ width: 70, height: 34 }} value={lineInput} maxLength={3} inputMode="numeric"
              onChange={(e) => setLineInput(e.target.value.trim())} />
            <button className="sbtn" type="submit" disabled={isRunning}>{t('player.debug.runToLine')}</button>
          </form>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            {t('player.debug.address')} 0x
            <input className="field" style={{ width: 90, height: 34 }} defaultValue={hex16(memAddr)} maxLength={4}
              onChange={(e) => { const v = parseInt(e.target.value, 16); if (!isNaN(v) && v >= 0 && v <= 0xffff) setMemAddr(v); }} />
          </label>
          <pre style={{ ...mono, fontSize: 11, margin: 0, overflowX: 'auto' }}>
            {Array.from({ length: 16 }, (_, row) => `${hex16((memAddr + row * 16) & 0xffff)}: ${Array.from({ length: 16 }, (_, c) => (memView[row * 16 + c] !== undefined ? hex8(memView[row * 16 + c]) : '--')).join(' ')}`).join('\n')}
          </pre>
        </div>
      )}
      {tab === 'disasm' && (
        <>
          {controls}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <FileButton className="sbtn" accept={fileAccept('.sym')} onFiles={([f]) => loadSyms(f)}>{t('player.debug.loadSymbols')}</FileButton>
            {syms && <span role="status">{t('player.debug.symbolsLoaded', { count: syms.byName.size, skipped: syms.skipped })}</span>}
          </div>
          {registers ? <Disassembly emu={emu} pc={registers.pc} syms={syms} /> : <p>{t('player.debug.noRom')}</p>}
        </>
      )}
      {tab === 'serial' && (
        <>
          <button className="sbtn" onClick={() => { clearSerialOutput(); setSerial(''); }}>{t('player.debug.clear')}</button>
          <pre style={{ ...mono, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 400, overflowY: 'auto' }}>{serial || t('player.debug.noOutput')}</pre>
        </>
      )}
      {(tab === 'tiles' || tab === 'maps' || tab === 'oam' || tab === 'palettes') && <PpuViews emu={emu} view={tab} />}
    </div>
  );
}
