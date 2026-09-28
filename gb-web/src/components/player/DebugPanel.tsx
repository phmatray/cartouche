import { useState, useCallback, useEffect, useRef } from 'react';
import type { useEmulator } from '../../hooks/useEmulator';
import { useT } from '../../i18n';

function hex8(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, '0');
}

function hex16(v: number): string {
  return v.toString(16).toUpperCase().padStart(4, '0');
}

// DMG palette as packed Uint32 (matches PALETTE_COLORS in gb-core/src/ppu.rs)
const DMG_PALETTE_U32 = new Uint32Array(4);
{
  const buf = new ArrayBuffer(16);
  const u8 = new Uint8Array(buf);
  const RGBA: [number, number, number, number][] = [
    [0xE0, 0xF8, 0xD0, 0xFF],
    [0x88, 0xC0, 0x70, 0xFF],
    [0x34, 0x68, 0x56, 0xFF],
    [0x08, 0x18, 0x20, 0xFF],
  ];
  for (let i = 0; i < 4; i++) {
    u8[i * 4] = RGBA[i][0];
    u8[i * 4 + 1] = RGBA[i][1];
    u8[i * 4 + 2] = RGBA[i][2];
    u8[i * 4 + 3] = RGBA[i][3];
  }
  const u32 = new Uint32Array(buf);
  for (let i = 0; i < 4; i++) DMG_PALETTE_U32[i] = u32[i];
}

function renderTiles(canvas: HTMLCanvasElement, vram: Uint8Array, bgp: number) {
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(128, 192);
  const pixels = new Uint32Array(imageData.data.buffer);

  for (let tileIdx = 0; tileIdx < 384; tileIdx++) {
    const tileX = (tileIdx % 16) * 8;
    const tileY = Math.floor(tileIdx / 16) * 8;
    const baseAddr = tileIdx * 16;

    for (let row = 0; row < 8; row++) {
      const lo = vram[baseAddr + row * 2];
      const hi = vram[baseAddr + row * 2 + 1];
      const rowOffset = (tileY + row) * 128 + tileX;
      for (let col = 0; col < 8; col++) {
        const bit = 7 - col;
        const colorId = ((hi >> bit) & 1) << 1 | ((lo >> bit) & 1);
        const shade = (bgp >> (colorId * 2)) & 0x03;
        pixels[rowOffset + col] = DMG_PALETTE_U32[shade];
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

/** Development aid in the manual's Game page: CPU registers, memory, serial output, VRAM tiles. */
export function DebugPanel({ emu, isRunning }: { emu: ReturnType<typeof useEmulator>; isRunning: boolean }) {
  const { registers, readMemory, updateRegisters, getSerialOutput, clearSerialOutput, getVramData, getBgp,
    setIsRunning, stepInstruction, stepFrame, breakReason, breakpoints, addBreakpoint, removeBreakpoint } = emu;
  const [bpInput, setBpInput] = useState('');
  const [tab, setTab] = useState<'cpu' | 'serial' | 'tiles'>('cpu');
  const [memAddr, setMemAddr] = useState(0x0000);
  const [memView, setMemView] = useState<number[]>([]);
  const [serial, setSerial] = useState('');
  const tileCanvasRef = useRef<HTMLCanvasElement>(null);
  const t = useT();

  const refresh = useCallback(() => {
    updateRegisters();
    setMemView(Array.from({ length: 256 }, (_, i) => readMemory((memAddr + i) & 0xffff)));
    setSerial(getSerialOutput());
    const canvas = tileCanvasRef.current, vram = getVramData();
    if (canvas && vram) renderTiles(canvas, vram, getBgp());
  }, [updateRegisters, readMemory, memAddr, getSerialOutput, getVramData, getBgp]);

  // Live while running (twice a second), once when paused.
  useEffect(() => {
    const first = requestAnimationFrame(refresh);
    const t = isRunning ? window.setInterval(refresh, 500) : 0;
    return () => { cancelAnimationFrame(first); window.clearInterval(t); };
  }, [isRunning, refresh, tab]);

  const addBp = () => {
    const v = parseInt(bpInput, 16);
    if (/^[0-9a-f]{1,4}$/i.test(bpInput) && v <= 0xffff) { addBreakpoint(v); setBpInput(''); }
  };

  const mono = { font: '600 12px/1.5 ui-monospace,Menlo,monospace' };
  return (
    <div style={{ marginTop: 16 }}>
      <div className="seg" role="group" aria-label={t('player.debug.view')} style={{ marginBottom: 14 }}>
        {(['cpu', 'serial', 'tiles'] as const).map((v) => <button key={v} aria-pressed={tab === v} onClick={() => setTab(v)}>{t(`player.debug.${v}`)}</button>)}
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
          <div role="group" aria-label={t('player.debug.controls')} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {isRunning
              ? <button className="sbtn" onClick={() => setIsRunning(false)}>{t('player.debug.pause')}</button>
              : <button className="sbtn" onClick={() => setIsRunning(true)}>{t('player.debug.continue')}</button>}
            <button className="sbtn" disabled={isRunning} onClick={() => { stepInstruction(); refresh(); }}>{t('player.debug.step')}</button>
            <button className="sbtn" disabled={isRunning} onClick={() => { stepFrame(); refresh(); }}>{t('player.debug.stepFrame')}</button>
          </div>
          {breakReason && !isRunning && <p role="status" style={{ margin: '0 0 8px' }}>{t('player.debug.stoppedAt', { reason: breakReason })}</p>}
          <form style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }} onSubmit={(e) => { e.preventDefault(); addBp(); }}>
            <label htmlFor="debug-bp">{t('player.debug.breakpoints')} 0x</label>
            <input id="debug-bp" className="field" style={{ width: 90, height: 34 }} value={bpInput} maxLength={4}
              onChange={(e) => setBpInput(e.target.value.trim())} />
            <button className="sbtn" type="submit">{t('player.debug.addBreakpoint')}</button>
          </form>
          {breakpoints.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {breakpoints.map((a) => (
                <li key={a}>
                  <button className="sbtn" aria-label={t('player.debug.removeBreakpoint', { addr: hex16(a) })} onClick={() => removeBreakpoint(a)}>{hex16(a)} ×</button>
                </li>
              ))}
            </ul>
          )}
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
      {tab === 'serial' && (
        <>
          <button className="sbtn" onClick={() => { clearSerialOutput(); setSerial(''); }}>{t('player.debug.clear')}</button>
          <pre style={{ ...mono, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 400, overflowY: 'auto' }}>{serial || t('player.debug.noOutput')}</pre>
        </>
      )}
      {tab === 'tiles' && <canvas ref={tileCanvasRef} width={128} height={192} style={{ width: 256, height: 384, imageRendering: 'pixelated', background: '#0b0b0b' }} />}
    </div>
  );
}
