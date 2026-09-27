import { useState } from 'react';
import { Link } from 'react-router';
import { useSettingsStore, type ScreenSize } from '../../store/settingsStore';
import type { ScreenKind } from '../../shaders/filters';
import { MotionRows, ScreenFilters } from './ScreenFilters';
import { Row, Seg } from './parts';

/** Sample frames for the previews, drawn in the core's own colours so each filter treats them as a game frame. */
const SAMPLES: Record<ScreenKind, Uint8ClampedArray> = (() => {
  const dmg = new Uint8ClampedArray(160 * 144 * 4), cgb = new Uint8ClampedArray(160 * 144 * 4);
  // The core's four DMG shades, lightest first: bands over a checkerboard with a sun.
  const shades = [[0xe0, 0xf8, 0xd0], [0x88, 0xc0, 0x70], [0x34, 0x68, 0x56], [0x08, 0x18, 0x20]];
  // Colour bars, a hue ramp and skin / sky / grass tones, on the 5-bit-per-channel grid a GBC can show.
  const bars = [[31, 31, 31], [31, 31, 0], [0, 31, 31], [0, 31, 0], [31, 0, 31], [31, 0, 0], [0, 0, 31], [0, 0, 0]];
  const tones = [[31, 24, 18], [12, 20, 31], [8, 22, 6], [24, 12, 6]];
  const hue = (h: number) => [0, 4, 2].map((o) => Math.round(31 * Math.max(0, Math.min(1, Math.abs(((h * 6 + o) % 6) - 3) - 1))));
  for (let y = 0; y < 144; y++) for (let x = 0; x < 160; x++) {
    const i = (y * 160 + x) * 4;
    const sun = (x - 118) ** 2 + (y - 34) ** 2 < 18 ** 2;
    const s = sun ? 0 : y < 72 ? Math.floor(x / 40) : ((x >> 3) + (y >> 3)) % 2 ? 1 : 3;
    dmg.set([...shades[s], 255], i);
    const c = y < 64 ? bars[Math.floor(x / 20)] : y < 100 ? hue(x / 160) : tones[(x >> 3) % 2 + ((y >> 3) % 2) * 2];
    cgb.set([...c.map((v) => Math.floor(v * 255 / 31)), 255], i);
  }
  return { dmg, cgb };
})();

export function DisplayTab() {
  const { screenSize, setScreenSize } = useSettingsStore();
  const [kind, setKind] = useState<ScreenKind>('dmg');
  return (
    <>
      <h2>Display</h2>
      <p className="intro">The screen every game starts with. Original Game Boy and Game Boy Color games each have their own default; a game can keep its own settings from its manual.</p>
      <h3>Screen style</h3>
      <Row label="Defaults for" sub={kind === 'dmg' ? 'Palettes recolor the four shades of an original Game Boy' : 'Color games keep their own colors; palettes never apply'}>
        <Seg<ScreenKind> label="Defaults for" value={kind} options={[['dmg', 'Game Boy'], ['cgb', 'Color']]} set={setKind} />
      </Row>
      <ScreenFilters key={kind} kind={kind} frame={SAMPLES[kind]} />
      <h3>Motion</h3>
      <MotionRows />
      <h3>Size</h3>
      <Row label="Default size" sub="Fit fills the stage; fixed sizes stay pixel-perfect">
        <Seg<ScreenSize> label="Default size" value={screenSize} options={[['fit', 'Fit'], ['2', '2×'], ['3', '3×'], ['4', '4×']]} set={setScreenSize} />
      </Row>
      <h3>Box art</h3>
      <p className="intro" style={{ margin: '8px 0 0' }}>Box art is off by default. Turn it on, see its size or delete it in <Link to="/settings/storage" style={{ color: 'var(--ink)' }}>Storage</Link>.</p>
    </>
  );
}
