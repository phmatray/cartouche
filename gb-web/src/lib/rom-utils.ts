import { num, size, t } from '../i18n/core.ts';

/** The ROM without the 512-byte copier header some old dumps carry in front (16 KB banks + 0x200). */
export const withoutCopierHeader = (data: Uint8Array) => (data.length % 0x4000 === 0x200 ? data.slice(0x200) : data); // a copy: callers hash and store `.buffer`

/**
 * A real Game Boy ROM: the header checksum (0x14D, over 0x134-0x14C) is right and the ROM-size byte
 * (0x148) matches the file length. The core refuses a bad checksum, so such files are never stored.
 */
export function isGameBoyRom(data: Uint8Array): boolean {
  if (data.length < 0x8000) return false;
  let x = 0;
  for (let i = 0x134; i <= 0x14c; i++) x = (x - data[i] - 1) & 0xff;
  return x === data[0x14d] && data[0x148] <= 8 && data.length === 0x8000 << data[0x148];
}

/**
 * Why a .sav file can't be this cartridge's battery save, or null when its size fits: exactly the
 * cartridge RAM (header 0x149; MBC2's built-in 512 bytes), plus 44 or 48 bytes of clock on an MBC3 with a timer.
 */
export function savSizeError(rom: Uint8Array, bytes: number): string | null {
  const type = rom[0x147];
  const ram = type === 0x05 || type === 0x06 ? 512 : ({ 1: 2048, 2: 8192, 3: 32768, 4: 131072, 5: 65536 } as Record<number, number>)[rom[0x149]] ?? 0;
  if (!ram) return t('game.sav.noRam');
  const ok = [ram, ...(type === 0x0f || type === 0x10 ? [ram + 44, ram + 48] : [])];
  return ok.includes(bytes) ? null : t('game.sav.wrongSize', { size: num(bytes), ram: size(ram), bytes: num(ram) });
}

/** A title as compared across the app: no accents, case, spaces or punctuation. */
export const titleKey = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Whether a ROM's header title names this catalog game: the same title, or (6+ characters) the start of it, as GB Studio
 * headers cut long titles ('OPOSSUMCOUNTR'). All a file with no known SHA-1 can be checked against.
 */
export function headerNames(title: string, header: string) {
  const k = titleKey(title), h = titleKey(header);
  return !!h && (h === k || (h.length >= 6 && k.startsWith(h)));
}

/**
 * Extract the game title from a Game Boy ROM header.
 * Title is at bytes 0x0134-0x0143 (up to 16 ASCII chars, null-padded).
 */
export function parseRomTitle(romData: Uint8Array): string {
  if (romData.length < 0x0144) return '';
  const titleBytes = romData.slice(0x0134, 0x0144);
  let title = '';
  for (const byte of titleBytes) {
    if (byte === 0) break;
    if (byte >= 0x20 && byte <= 0x7E) title += String.fromCharCode(byte);
  }
  return title.trim();
}

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------

const CARTRIDGE_TYPE_MAP: Record<number, string> = {
  0x00: 'ROM Only',
  0x01: 'MBC1',
  0x02: 'MBC1+RAM',
  0x03: 'MBC1+RAM+BATTERY',
  0x05: 'MBC2',
  0x06: 'MBC2+BATTERY',
  0x08: 'ROM+RAM',
  0x09: 'ROM+RAM+BATTERY',
  0x0B: 'MMM01',
  0x0C: 'MMM01+RAM',
  0x0D: 'MMM01+RAM+BATTERY',
  0x0F: 'MBC3+TIMER+BATTERY',
  0x10: 'MBC3+TIMER+RAM+BATTERY',
  0x11: 'MBC3',
  0x12: 'MBC3+RAM',
  0x13: 'MBC3+RAM+BATTERY',
  0x19: 'MBC5',
  0x1A: 'MBC5+RAM',
  0x1B: 'MBC5+RAM+BATTERY',
  0x1C: 'MBC5+RUMBLE',
  0x1D: 'MBC5+RUMBLE+RAM',
  0x1E: 'MBC5+RUMBLE+RAM+BATTERY',
  0x20: 'MBC6',
  0x22: 'MBC7+SENSOR+RUMBLE+RAM+BATTERY',
  0xFC: 'POCKET CAMERA',
  0xFD: 'BANDAI TAMA5',
  0xFE: 'HuC3',
  0xFF: 'HuC1+RAM+BATTERY',
};

/** Mappers the core emulates (gb-core cartridge.rs); anything else fails to load. */
const SUPPORTED_TYPES = new Set([0x00, 0x01, 0x02, 0x03, 0x05, 0x06, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x22, 0xFC, 0xFE, 0xFF].map((b) => CARTRIDGE_TYPE_MAP[b]));

/** False for a cartridge whose mapper the core can't run yet (MMM01, MBC6...). */
export const mapperSupported = (h: RomMetadata) => SUPPORTED_TYPES.has(h.cartridgeType);

const ROM_SIZE_MAP: Record<number, string> = {
  0x00: '32 KB',
  0x01: '64 KB',
  0x02: '128 KB',
  0x03: '256 KB',
  0x04: '512 KB',
  0x05: '1 MB',
  0x06: '2 MB',
  0x07: '4 MB',
  0x08: '8 MB',
};

const RAM_SIZE_MAP: Record<number, string> = {
  0x00: 'None',
  0x01: '2 KB',
  0x02: '8 KB',
  0x03: '32 KB',
  0x04: '128 KB',
  0x05: '64 KB',
};

/** New licensee codes (bytes 0x0144-0x0145, when old licensee = 0x33) */
const NEW_LICENSEE_MAP: Record<string, string> = {
  '01': 'Nintendo R&D1',
  '08': 'Capcom',
  '13': 'Electronic Arts',
  '18': 'Hudson Soft',
  '19': 'B-AI',
  '20': 'KSS',
  '22': 'Planning Office WADA',
  '24': 'PCM Complete',
  '25': 'San-X',
  '28': 'Kemco Japan',
  '29': 'Seta',
  '30': 'Viacom',
  '31': 'Nintendo',
  '32': 'Bandai',
  '33': 'Ocean/Acclaim',
  '34': 'Konami',
  '35': 'HectorSoft',
  '37': 'Taito',
  '38': 'Hudson',
  '39': 'Banpresto',
  '41': 'Ubi Soft',
  '42': 'Atlus',
  '44': 'Malibu',
  '46': 'Angel',
  '47': 'Bullet-Proof',
  '49': 'Irem',
  '50': 'Absolute',
  '51': 'Acclaim',
  '52': 'Activision',
  '53': 'American Sammy',
  '54': 'Konami',
  '55': 'Hi Tech Entertainment',
  '56': 'LJN',
  '57': 'Matchbox',
  '58': 'Mattel',
  '59': 'Milton Bradley',
  '60': 'Titus',
  '61': 'Virgin',
  '64': 'LucasArts',
  '67': 'Ocean',
  '69': 'EA (Electronic Arts)',
  '70': 'Infogrames',
  '71': 'Interplay',
  '72': 'Broderbund',
  '73': 'Sculptured',
  '75': 'The Sales Curve',
  '78': 'THQ',
  '79': 'Accolade',
  '80': 'Misawa',
  '83': 'lozc',
  '86': 'Tokuma Shoten i',
  '87': 'Tsukuda Ori',
  '91': 'Chunsoft',
  '92': 'Video System',
  '93': 'Ocean/Acclaim',
  '95': 'Varie',
  '96': 'Yonezawa/s\'pal',
  '97': 'Kaneko',
  '99': 'Pack in soft',
  'A4': 'Konami (Yu-Gi-Oh!)',
};

/** Old licensee codes (byte 0x014B) */
const OLD_LICENSEE_MAP: Record<number, string> = {
  0x01: 'Nintendo',
  0x08: 'Capcom',
  0x09: 'HOT-B',
  0x0A: 'Jaleco',
  0x0B: 'Coconuts Japan',
  0x0C: 'Elite Systems',
  0x13: 'EA (Electronic Arts)',
  0x18: 'Hudson Soft',
  0x19: 'ITC Entertainment',
  0x1A: 'Yanoman',
  0x1D: 'Japan Clary',
  0x1F: 'Virgin Games',
  0x24: 'PCM Complete',
  0x25: 'San-X',
  0x28: 'Kotobuki Systems',
  0x29: 'Seta',
  0x30: 'Infogrames',
  0x31: 'Nintendo',
  0x32: 'Bandai',
  0x33: 'Use New Licensee Code',
  0x34: 'Konami',
  0x35: 'HectorSoft',
  0x38: 'Capcom',
  0x39: 'Banpresto',
  0x3C: '.Entertainment i',
  0x3E: 'Gremlin',
  0x41: 'Ubi Soft',
  0x42: 'Atlus',
  0x44: 'Malibu',
  0x46: 'Angel',
  0x47: 'Spectrum Holobyte',
  0x49: 'Irem',
  0x4A: 'Virgin Games',
  0x4D: 'Malibu',
  0x4F: 'US Gold',
  0x50: 'Absolute',
  0x51: 'Acclaim',
  0x52: 'Activision',
  0x53: 'American Sammy',
  0x54: 'GameTek',
  0x55: 'Park Place',
  0x56: 'LJN',
  0x57: 'Matchbox',
  0x59: 'Milton Bradley',
  0x5A: 'Mindscape',
  0x5B: 'Romstar',
  0x5C: 'Naxat Soft',
  0x5D: 'Tradewest',
  0x60: 'Titus',
  0x61: 'Virgin Games',
  0x67: 'Ocean',
  0x69: 'EA (Electronic Arts)',
  0x6E: 'Elite Systems',
  0x6F: 'Electro Brain',
  0x70: 'Infogrames',
  0x71: 'Interplay',
  0x72: 'Broderbund',
  0x73: 'Sculptered Soft',
  0x75: 'The Sales Curve',
  0x78: 'THQ',
  0x79: 'Accolade',
  0x7A: 'Triffix Entertainment',
  0x7C: 'Microprose',
  0x7F: 'Kemco',
  0x80: 'Misawa',
  0x83: 'Lozc',
  0x86: 'Tokuma Shoten i',
  0x8B: 'Bullet-Proof Software',
  0x8C: 'Vic Tokai',
  0x8E: 'Ape',
  0x8F: "I'Max",
  0x91: 'Chunsoft',
  0x92: 'Video System',
  0x93: 'Tsubaraya Productions',
  0x95: 'Varie',
  0x96: "Yonezawa/S'Pal",
  0x97: 'Kaneko',
  0x99: 'Arc',
  0x9A: 'Nihon Bussan',
  0x9B: 'Tecmo',
  0x9C: 'Imagineer',
  0x9D: 'Banpresto',
  0x9F: 'Nova',
  0xA1: 'Hori Electric',
  0xA2: 'Bandai',
  0xA4: 'Konami',
  0xA6: 'Kawada',
  0xA7: 'Takara',
  0xA9: 'Technos Japan',
  0xAA: 'Broderbund',
  0xAC: 'Toei Animation',
  0xAD: 'Toho',
  0xAF: 'Namco',
  0xB0: 'Acclaim',
  0xB1: 'ASCII or Nexsoft',
  0xB2: 'Bandai',
  0xB4: 'Enix',
  0xB6: 'HAL Laboratory',
  0xB7: 'SNK',
  0xB9: 'Pony Canyon',
  0xBA: 'Culture Brain',
  0xBB: 'Sunsoft',
  0xBD: 'Sony Imagesoft',
  0xBF: 'Sammy',
  0xC0: 'Taito',
  0xC2: 'Kemco',
  0xC3: 'Squaresoft',
  0xC4: 'Tokuma Shoten i',
  0xC5: 'Data East',
  0xC6: 'Tonkinhouse',
  0xC8: 'Koei',
  0xC9: 'UFL',
  0xCA: 'Ultra',
  0xCB: 'Vap',
  0xCC: 'Use Corporation',
  0xCD: 'Meldac',
  0xCE: 'Pony Canyon or',
  0xCF: 'Angel',
  0xD0: 'Taito',
  0xD1: 'Sofel',
  0xD2: 'Quest',
  0xD3: 'Sigma Enterprises',
  0xD4: 'Ask Kodansha',
  0xD6: 'Naxat Soft',
  0xD7: 'Copya System',
  0xD9: 'Banpresto',
  0xDA: 'Tomy',
  0xDB: 'LJN',
  0xDD: 'NCS',
  0xDE: 'Human',
  0xDF: 'Altron',
  0xE0: 'Jaleco',
  0xE1: 'Towa Chiki',
  0xE2: 'Yutaka',
  0xE3: 'Varie',
  0xE5: 'Epcoh',
  0xE7: 'Athena',
  0xE8: 'Asmik Ace Entertainment',
  0xE9: 'Natsume',
  0xEA: 'King Records',
  0xEB: 'Atlus',
  0xEC: 'Epic/Sony Records',
  0xEE: 'IGS',
  0xF0: 'A Wave',
  0xF3: 'Extreme Entertainment',
  0xFF: 'LJN',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CgbFlag = 'DMG Only' | 'CGB Compatible' | 'CGB Only';
export type SgbFlag = 'Not Supported' | 'SGB Supported';
export type Region = 'Japan' | 'International';

export interface RomMetadata {
  title: string;
  cgbFlag: CgbFlag;
  sgbFlag: SgbFlag;
  cartridgeType: string;
  romSize: string;
  ramSize: string;
  region: Region;
  /** '' when the header names none, or a code not in the lists. */
  publisher: string;
  romVersion: number;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse the Game Boy ROM header and return structured metadata.
 * Returns null if the ROM data is too short to contain a valid header.
 */
export function parseRomHeader(data: Uint8Array): RomMetadata | null {
  if (data.length < 0x0150) return null;

  // Title: 0x0134-0x0143 (last byte overlaps with CGB flag)
  const titleBytes = data.slice(0x0134, 0x0144);
  let title = '';
  for (const byte of titleBytes) {
    if (byte === 0) break;
    if (byte >= 0x20 && byte <= 0x7E) title += String.fromCharCode(byte);
  }
  title = title.trim();

  // CGB flag: byte 0x0143
  const cgbByte = data[0x0143];
  let cgbFlag: CgbFlag;
  if (cgbByte === 0xC0) cgbFlag = 'CGB Only';
  else if (cgbByte & 0x80) cgbFlag = 'CGB Compatible'; // bit 7, as the core decides
  else cgbFlag = 'DMG Only';

  // SGB flag: byte 0x0146, which the Super Game Boy only honours with the old licensee code 0x33
  const sgbFlag: SgbFlag = data[0x0146] === 0x03 && data[0x014B] === 0x33 ? 'SGB Supported' : 'Not Supported';

  // Cartridge type: byte 0x0147
  const cartridgeByte = data[0x0147];
  const cartridgeType = CARTRIDGE_TYPE_MAP[cartridgeByte] ?? `Unknown (0x${cartridgeByte.toString(16).toUpperCase().padStart(2, '0')})`;

  // ROM size: byte 0x0148
  const romByte = data[0x0148];
  const romSize = ROM_SIZE_MAP[romByte] ?? `Unknown (0x${romByte.toString(16).toUpperCase().padStart(2, '0')})`;

  // RAM size: byte 0x0149
  const ramByte = data[0x0149];
  const ramSize = RAM_SIZE_MAP[ramByte] ?? `Unknown (0x${ramByte.toString(16).toUpperCase().padStart(2, '0')})`;

  // Region: byte 0x014A
  const region: Region = data[0x014A] === 0x00 ? 'Japan' : 'International';

  // Publisher: old licensee at 0x014B; if 0x33 use new licensee at 0x0144-0x0145. '' for none (code 00) or an unknown code.
  const oldLicensee = data[0x014B];
  const publisher = (oldLicensee === 0x33 ? NEW_LICENSEE_MAP[String.fromCharCode(data[0x0144], data[0x0145])] : OLD_LICENSEE_MAP[oldLicensee]) ?? '';

  // ROM version: byte 0x014C
  const romVersion = data[0x014C];

  return { title, cgbFlag, sgbFlag, cartridgeType, romSize, ramSize, region, publisher, romVersion };
}

/** Super Game Boy functions: 'dmg' an original Game Boy game, 'cgb' a Color game (not a Color-only one), null none. */
export function sgbCartOf(h: RomMetadata | null): 'dmg' | 'cgb' | null {
  if (!h || h.sgbFlag !== 'SGB Supported' || h.cgbFlag === 'CGB Only') return null;
  return h.cgbFlag === 'DMG Only' ? 'dmg' : 'cgb';
}

/**
 * Compute the SHA1 hash of ROM data using Web Crypto API.
 * Returns a lowercase hex string (40 chars).
 */
export async function computeSha1(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-1', data.buffer as ArrayBuffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}
