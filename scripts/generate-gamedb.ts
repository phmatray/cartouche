#!/usr/bin/env npx tsx
/**
 * Fetches Game Boy and Game Boy Color CSV databases from PigSaint/GameDataBase
 * and generates gamedb.json keyed by SHA1 hash for instant ROM lookups.
 * Each entry also gets its No-Intro name from the libretro-database DATs (joined by SHA-1):
 * sanitized, that name is the file name of its box art in libretro-thumbnails, so the app never
 * has to list the thumbnail repository at runtime.
 */

const BASE_URL = 'https://raw.githubusercontent.com/PigSaint/GameDataBase/main/';
const CSV_FILES = [
  { file: 'console_nintendo_gameboy.csv', platform: 'gb' as const },
  { file: 'console_nintendo_gameboycolor.csv', platform: 'gbc' as const },
];
const DAT_BASE = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/';
const DATS = ['Nintendo - Game Boy.dat', 'Nintendo - Game Boy Color.dat'];

/** Only the columns the app shows (the file is fetched lazily, when a ROM is identified). */
interface GameDbEntry {
  title: string;
  developer: string;
  year: string;
  region: string;
  genre: string;
  players: number;
  platform: 'gb' | 'gbc';
  /** libretro-thumbnails file name (without .png), in the repository of `platform`. */
  libretroName?: string;
}

/** SHA-1 -> No-Intro name, with the characters libretro-thumbnails replaces (&*\/:`<>?|") turned into "_". */
async function fetchDatNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const dat of DATS) {
    const res = await fetch(DAT_BASE + encodeURIComponent(dat));
    if (!res.ok) throw new Error(`Failed to fetch ${dat}: ${res.status}`);
    const text = await res.text();
    for (const m of text.matchAll(/game \(\s*name "([^"]*)"[\s\S]*?sha1 ([0-9A-Fa-f]{40})/g)) {
      names.set(m[2].toLowerCase(), m[1].replace(/[&*/:`<>?\\|"]/g, '_'));
    }
  }
  return names;
}

/**
 * Parse CSV text handling quoted fields with embedded commas and newlines.
 * Returns an array of string arrays (rows of columns).
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const row: string[] = [];
    while (i < len) {
      let value = '';
      if (text[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') {
              value += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            value += text[i];
            i++;
          }
        }
      } else {
        // Unquoted field
        while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          value += text[i];
          i++;
        }
      }
      row.push(value.trim());

      if (i < len && text[i] === ',') {
        i++; // skip comma, continue to next field
      } else {
        break; // end of row
      }
    }
    // Skip line ending
    if (i < len && text[i] === '\r') i++;
    if (i < len && text[i] === '\n') i++;

    if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Parse the Tags field (space-separated hashtags) into structured data.
 * Example: "#players:1 #genre:action>platformer #save:password #lang:en #compatibility:gameboy>mono"
 */
function parseTags(tags: string): {
  genre: string;
  players: string;
  compatibility: string;
  language: string;
  saveType: string;
} {
  const result = { genre: '', players: '', compatibility: '', language: '', saveType: '' };
  if (!tags) return result;

  const parts = tags.split(/\s+/);
  for (const part of parts) {
    if (part.startsWith('#genre:')) {
      const value = part.slice('#genre:'.length);
      // Take the first segment before '>' or ':' as the main genre
      const mainGenre = value.split(/[>:]/)[0];
      result.genre = mainGenre.charAt(0).toUpperCase() + mainGenre.slice(1);
    } else if (part.startsWith('#players:')) {
      result.players = part.slice('#players:'.length);
    } else if (part.startsWith('#compatibility:')) {
      const value = part.slice('#compatibility:'.length);
      // Extract the part after '>' (e.g., "gameboy>mono" -> "mono")
      const segments = value.split('>');
      result.compatibility = segments.length > 1 ? segments[segments.length - 1] : segments[0];
    } else if (part.startsWith('#lang:')) {
      result.language = part.slice('#lang:'.length);
    } else if (part.startsWith('#save:')) {
      result.saveType = part.slice('#save:'.length);
    }
  }
  return result;
}

/**
 * Extract the part before '@' from a "title @ exact" field.
 */
function extractBeforeAt(field: string): string {
  const idx = field.indexOf('@');
  if (idx === -1) return field.trim();
  return field.slice(0, idx).trim();
}

async function main() {
  const allEntries: Record<string, GameDbEntry> = {};
  const datNames = await fetchDatNames();

  for (const { file: csvFile, platform } of CSV_FILES) {
    const url = BASE_URL + csvFile;
    console.log(`Fetching ${csvFile}...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${csvFile}: ${res.status}`);
    const text = await res.text();

    const rows = parseCsv(text);
    if (rows.length < 2) {
      console.warn(`${csvFile}: no data rows found`);
      continue;
    }

    // First row is header
    const header = rows[0];
    const colIndex: Record<string, number> = {};
    for (let i = 0; i < header.length; i++) {
      colIndex[header[i].toLowerCase()] = i;
    }

    // Map expected column names (case-insensitive)
    const col = (name: string): number => {
      const key = name.toLowerCase();
      // Try exact match first, then partial
      if (colIndex[key] !== undefined) return colIndex[key];
      for (const [k, v] of Object.entries(colIndex)) {
        if (k.includes(key)) return v;
      }
      return -1;
    };

    const iScreenTitle = colIndex['title'] ?? col('screen title'); // upstream renamed "Screen title" to "Title"
    const iRegion = col('region');
    const iReleaseDate = col('release date');
    const iDeveloper = col('developer');
    const iTags = col('tags');
    const iSha1 = col('sha1');

    if (iSha1 === -1) {
      console.warn(`${csvFile}: SHA1 column not found, skipping`);
      continue;
    }

    let added = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const sha1 = (row[iSha1] ?? '').trim().toLowerCase();
      if (!sha1) continue;

      // Keep first match per SHA1
      if (allEntries[sha1]) continue;

      const tags = parseTags(row[iTags] ?? '');

      allEntries[sha1] = {
        title: extractBeforeAt(row[iScreenTitle] ?? ''),
        developer: (row[iDeveloper] ?? '').trim(),
        year: (row[iReleaseDate] ?? '').trim().slice(0, 4),
        region: (row[iRegion] ?? '').trim(),
        genre: tags.genre,
        players: parseInt(tags.players) || 1,
        platform,
        libretroName: datNames.get(sha1),
      };
      added++;
    }
    console.log(`  Parsed ${rows.length - 1} rows, added ${added} new entries`);
  }

  const outPath = new URL('../gb-web/src/data/gamedb.json', import.meta.url);
  const { writeFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  // One entry per line: compact (the app fetches it as a static asset) yet diffable.
  const lines = Object.entries(allEntries).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  writeFileSync(fileURLToPath(outPath), `{\n${lines.join(',\n')}\n}\n`);

  const named = Object.values(allEntries).filter((e) => e.libretroName).length;
  console.log(`Generated ${Object.keys(allEntries).length} entries (${named} with a box-art name) -> gb-web/src/data/gamedb.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
