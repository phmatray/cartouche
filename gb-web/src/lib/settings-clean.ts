// Object-valued settings from untrusted input (a restored backup), checked field by field like an imported controls file.
import { normalizeDisplay } from '../shaders/filters.ts';
import { cleanLayout, SHELLS, SKINS, type Layout } from './touch-layout.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const pick = <T,>(v: Obj, ok: (x: unknown) => x is T) => Object.fromEntries(Object.entries(v).filter(([, x]) => ok(x))) as Record<string, T>;
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';

/**
 * Returns `value` made safe for setting `key`, merged over `cur` (the value in use now) where it is a fixed-shape record,
 * or undefined to drop it. A partial record keeps the current value for what it leaves out; unknown fields are dropped.
 */
export function cleanSetting(key: string, value: unknown, cur: unknown): unknown {
  switch (key) {
    case 'keybindings':
    case 'channelMutes': {
      if (!isObj(value) || !isObj(cur)) return undefined;
      const ok = key === 'keybindings' ? isStr : isBool;
      return Object.fromEntries(Object.entries(cur).map(([k, c]) => [k, ok(value[k]) ? value[k] : c]));
    }
    case 'display':
      return isObj(value) ? { dmg: normalizeDisplay(value.dmg, 'dmg'), cgb: normalizeDisplay(value.cgb, 'cgb') } : undefined;
    case 'gameDisplay':
      return isObj(value) ? pick(value, isObj) : undefined; // normalized per game kind where it's read (useDisplay)
    case 'gameConsole':
      return isObj(value) ? pick(value, (x): x is string => typeof x === 'string' && /^(dmg|gbc|gbc([1-9]|1[0-2]))$/.test(x)) : undefined;
    case 'gameSgb':
    case 'snesMusic':
      return isObj(value) ? pick(value, isBool) : undefined;
    case 'touchLayouts': {
      if (!isObj(value)) return undefined;
      const out: Record<string, Layout> = {};
      for (const [k, l] of Object.entries(value)) { const c = cleanLayout(l); if (c) out[k] = c; }
      return out;
    }
    case 'touchSkin':
      return (SKINS as readonly unknown[]).includes(value) ? value : undefined;
    case 'touchShell':
      return (SHELLS as readonly unknown[]).includes(value) ? value : undefined;
    default:
      return value;
  }
}
