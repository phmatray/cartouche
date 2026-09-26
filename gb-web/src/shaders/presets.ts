import type { PresetName } from './lcd-engine';
import dmgClassicSource from './dmg-classic.glsl?raw';
import gbPocketSource from './gb-pocket.glsl?raw';
import gbLightSource from './gb-light.glsl?raw';
import cleanSource from './clean.glsl?raw';

export interface PresetInfo {
  name: PresetName;
  label: string;
  description: string;
  source: string;
}

export const PRESETS: PresetInfo[] = [
  {
    name: 'dmg-classic',
    label: 'DMG Classic',
    description: 'Original 1989 Game Boy',
    source: dmgClassicSource,
  },
  {
    name: 'gb-pocket',
    label: 'Pocket',
    description: 'Game Boy Pocket (1996)',
    source: gbPocketSource,
  },
  {
    name: 'gb-light',
    label: 'Light',
    description: 'Game Boy Light (1998)',
    source: gbLightSource,
  },
  {
    name: 'clean',
    label: 'Clean',
    description: 'No filter, raw pixels',
    source: cleanSource,
  },
];
