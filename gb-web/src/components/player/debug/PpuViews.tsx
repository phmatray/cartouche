import { useEffect, useRef, useState } from 'react';
import type { useEmulator } from '../../../hooks/useEmulator';
import { useT } from '../../../i18n';
import { cgbPalette, mapEntry, oamEntry, tileIndices, type RGB } from '../../../lib/ppu-view';

export type PpuView = 'tiles' | 'maps' | 'oam' | 'palettes';
type Emu = ReturnType<typeof useEmulator>;
type Palette = { name: string; colors: RGB[]; raw: string[] };

// The DMG shades (PALETTE_COLORS in gb-core/src/ppu.rs).
const SHADES: RGB[] = [[0xe0, 0xf8, 0xd0], [0x88, 0xc0, 0x70], [0x34, 0x68, 0x56], [0x08, 0x18, 0x20]];
// LCD registers as get_lcd_regs orders them.
const LCDC = 0, SCY = 2, SCX = 3, BGP = 6, OBP0 = 7, OBP1 = 8, WY = 9, WX = 10;

const hex = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const css = ([r, g, b]: RGB) => `rgb(${r} ${g} ${b})`;

function dmgPalette(name: string, reg: number): Palette {
  const shades = [0, 1, 2, 3].map((i) => (reg >> (i * 2)) & 3);
  return { name, colors: shades.map((s) => SHADES[s]), raw: shades.map(String) };
}

function cgbPalettes(prefix: string, cram: Uint8Array): Palette[] {
  return Array.from({ length: 8 }, (_, n) => ({
    name: `${prefix}${n}`,
    colors: cgbPalette(cram, n),
    raw: [0, 1, 2, 3].map((i) => `$${hex(cram[n * 8 + i * 2] | (cram[n * 8 + i * 2 + 1] << 8), 4)}`),
  }));
}

/** BGP/OBP0/OBP1 on DMG, BG0-7 then OBJ0-7 on CGB. */
function palettes(cgb: boolean, regs: Uint8Array, cram: { bg: Uint8Array; obj: Uint8Array } | null): Palette[] {
  if (cgb && cram) return [...cgbPalettes('BG', cram.bg), ...cgbPalettes('OBJ', cram.obj)];
  return [dmgPalette('BGP', regs[BGP]), dmgPalette('OBP0', regs[OBP0]), dmgPalette('OBP1', regs[OBP1])];
}

/** Paints tile `tile` of `bank` at (px, py) of an RGBA buffer `w` pixels wide; color 0 left alone when `clear0`. */
function blit(px: Uint8ClampedArray, w: number, x0: number, y0: number, vram: Uint8Array, bank: 0 | 1, tile: number,
  colors: RGB[], xflip = false, yflip = false, clear0 = false) {
  const ids = tileIndices(vram, bank, tile);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const id = ids[(yflip ? 7 - y : y) * 8 + (xflip ? 7 - x : x)];
      if (clear0 && id === 0) continue;
      const o = ((y0 + y) * w + x0 + x) * 4;
      [px[o], px[o + 1], px[o + 2]] = colors[id];
      px[o + 3] = 255;
    }
  }
}

function paint(canvas: HTMLCanvasElement | null, draw: (px: Uint8ClampedArray, w: number) => void) {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const img = ctx.createImageData(canvas.width, canvas.height);
  draw(img.data, canvas.width);
  ctx.putImageData(img, 0, 0);
  return ctx;
}

const pixelated = { imageRendering: 'pixelated', background: '#0b0b0b' } as const;
const mono = { font: '600 12px/1.5 ui-monospace,Menlo,monospace' };

/**
 * The PPU's memory, redrawn on every render (the Debug drawer re-renders on each refresh: twice a second
 * while running, once when paused or stepped).
 */
export function PpuViews({ emu, view }: { emu: Emu; view: PpuView }) {
  const { getVramData, getOam, getCram, getLcdRegs, isCgb } = emu;
  const t = useT();
  const [bank, setBank] = useState<0 | 1>(0);
  const [pal, setPal] = useState(0);
  const tilesRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLCanvasElement>(null);
  const winRef = useRef<HTMLCanvasElement>(null);

  const vram = getVramData(), oam = getOam(), cram = getCram(), regs = getLcdRegs();
  const pals = regs ? palettes(isCgb, regs, cram) : [];
  const palIdx = pal < pals.length ? pal : 0;

  useEffect(() => {
    if (!vram || !regs) return;
    if (view === 'tiles') {
      paint(tilesRef.current, (px, w) => {
        for (let i = 0; i < 384; i++) blit(px, w, (i % 16) * 8, (i >> 4) * 8, vram, bank, i, pals[palIdx].colors);
      });
    }
    if (view === 'maps') {
      const bgPal = (p: number) => (isCgb && cram ? cgbPalette(cram.bg, p) : pals[0].colors);
      for (const which of ['bg', 'win'] as const) {
        const ctx = paint(which === 'bg' ? bgRef.current : winRef.current, (px, w) => {
          for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
            const e = mapEntry(vram, regs[LCDC], which, x, y);
            blit(px, w, x * 8, y * 8, vram, isCgb ? e.bank : 0, (e.addr - 0x8000) >> 4, bgPal(e.palette),
              isCgb && e.xflip, isCgb && e.yflip);
          }
        });
        if (!ctx) continue;
        ctx.strokeStyle = '#ff3b5c';
        if (which === 'bg') {
          // The 160×144 viewport, drawn four times so it wraps around the 256×256 map.
          for (const dx of [0, -256]) for (const dy of [0, -256]) ctx.strokeRect(regs[SCX] + dx + 0.5, regs[SCY] + dy + 0.5, 159, 143);
        } else if (regs[WX] < 167 && regs[WY] < 144) {
          // The part of the window map on screen: it starts at (WX - 7, WY).
          ctx.strokeRect(0.5, 0.5, 167 - Math.max(regs[WX], 7) - 1, 144 - regs[WY] - 1);
        }
      }
    }
  });

  if (!vram || !regs || !oam) return <p>{t('player.debug.noRom')}</p>;
  const tall = (regs[LCDC] & 0x04) !== 0;

  const drawSprite = (canvas: HTMLCanvasElement | null, i: number) => {
    const e = oamEntry(oam, i);
    const colors = isCgb && cram ? cgbPalette(cram.obj, e.palette) : pals[1 + e.dmgPalette].colors;
    const b = isCgb ? e.bank : 0;
    paint(canvas, (px, w) => {
      if (!tall) return blit(px, w, 0, 0, vram, b, e.tile, colors, e.xflip, e.yflip, true);
      const [top, bottom] = e.yflip ? [e.tile | 1, e.tile & 0xfe] : [e.tile & 0xfe, e.tile | 1];
      blit(px, w, 0, 0, vram, b, top, colors, e.xflip, e.yflip, true);
      blit(px, w, 0, 8, vram, b, bottom, colors, e.xflip, e.yflip, true);
    });
  };

  const picker = (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
      {isCgb && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {t('player.debug.bank')}
          <select className="field" style={{ height: 34 }} value={bank} onChange={(e) => setBank(+e.target.value as 0 | 1)}>
            <option value={0}>0</option>
            <option value={1}>1</option>
          </select>
        </label>
      )}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {t('player.debug.palette')}
        <select className="field" style={{ height: 34 }} value={palIdx} onChange={(e) => setPal(+e.target.value)}>
          {pals.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
        </select>
      </label>
    </div>
  );

  return (
    <div style={mono}>
      {view === 'tiles' && (
        <>
          {picker}
          <canvas ref={tilesRef} width={128} height={192} role="img"
            aria-label={`${t('player.debug.tiles')}, ${t('player.debug.bank')} ${bank}, ${pals[palIdx]?.name}`}
            style={{ ...pixelated, width: 256, height: 384 }} />
        </>
      )}
      {view === 'maps' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <figure style={{ margin: 0 }}>
            <figcaption>{t('player.debug.bgMap')} · SCX {regs[SCX]} SCY {regs[SCY]}</figcaption>
            <canvas ref={bgRef} width={256} height={256} role="img"
              aria-label={`${t('player.debug.bgMap')}, SCX ${regs[SCX]}, SCY ${regs[SCY]}`}
              style={{ ...pixelated, width: 256, maxWidth: '100%' }} />
          </figure>
          <figure style={{ margin: 0 }}>
            <figcaption>{t('player.debug.winMap')} · WX {regs[WX]} WY {regs[WY]}</figcaption>
            <canvas ref={winRef} width={256} height={256} role="img"
              aria-label={`${t('player.debug.winMap')}, WX ${regs[WX]}, WY ${regs[WY]}`}
              style={{ ...pixelated, width: 256, maxWidth: '100%' }} />
          </figure>
        </div>
      )}
      {view === 'oam' && (
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: '12px 2px', textAlign: 'right' }}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">{t('player.debug.oamColumns.y')}</th>
                <th scope="col">{t('player.debug.oamColumns.x')}</th>
                <th scope="col">{t('player.debug.oamColumns.tile')}</th>
                <th scope="col">{t('player.debug.oamColumns.flags')}</th>
                <td />
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 40 }, (_, i) => {
                const e = oamEntry(oam, i);
                return (
                  <tr key={i}>
                    <th scope="row">{i}</th>
                    <td>{e.y}</td>
                    <td>{e.x}</td>
                    <td>${hex(e.tile)}</td>
                    <td>${hex(oam[i * 4 + 3])}</td>
                    <td>
                      <canvas ref={(c) => drawSprite(c, i)} width={8} height={tall ? 16 : 8} aria-hidden
                        style={{ ...pixelated, width: 16, height: tall ? 32 : 16, verticalAlign: 'middle' }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {view === 'palettes' && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
          {pals.map((p) => (
            <li key={p.name} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ width: 40 }}>{p.name}</span>
              {p.colors.map((c, i) => (
                <span key={i} role="img" title={p.raw[i]} aria-label={p.raw[i]}
                  style={{ width: 22, height: 22, background: css(c), border: '1px solid var(--line, #0003)' }} />
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
