export type RegionFilter = 'US' | 'EU' | 'JP';

export interface GameEntry {
  id: string;
  title: string;
  description: string;
  /** The description in the other languages (catalog entries). */
  descriptions?: Partial<Record<'fr' | 'es', string>>;
  genre: string;
  category: string;
  /** Bundled, freely licensed box art (a path under public/, e.g. covers/x.webp); '' when there is none. */
  coverArt: string;
  /** Attribution for coverArt (shown with the game's credits). */
  coverCredit?: string;
  screenshots: string[];
  romUrl?: string;
  libretroName?: string;
  romHeaderTitle?: string;
  sha1?: string;
  developer?: string;
  year?: string;
  /** License of the game itself (curated homebrew entries). */
  license?: string;
  /** Official page where the author distributes the game. */
  homepage?: string;
  /** Attribution for bundled homebrew (CC BY needs the notice, license link, source and changes). */
  copyright?: string;
  licenseUrl?: string;
  source?: string;
  changes?: string;
  /** Test cartridges: what a pass looks like, shown under the box. */
  hint?: string;
  hints?: Partial<Record<'fr' | 'es', string>>;
  isLocal: boolean;
  isFavorite?: boolean;
  lastPlayed?: number;
  totalPlayTime?: number;
  sessions?: number;
  importedAt?: number;
  regions?: RegionFilter[];
  // ROM header metadata (populated after loading)
  region?: string;
  cartridgeType?: string;
  romSize?: string;
  ramSize?: string;
  publisher?: string;
  cgbFlag?: string;
  sgbFlag?: string;
  players?: number;
  compatibility?: string;
  language?: string;
  saveType?: string;
  platform?: 'gb' | 'gbc';
  coverTitle?: string;
}

export interface LocalGameEntry extends GameEntry {
  isLocal: true;
  romData: Uint8Array;
}

export type GameLibrary = Record<string, GameEntry[]>;
