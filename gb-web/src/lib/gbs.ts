/** GBS (Game Boy Sound System) music files: what the library shows. The core re-validates at play time (gb-core/src/gbs.rs). */

export const isGbsFile = (name: string) => /\.gbs$/i.test(name);

export interface GbsInfo { songs: number; first: number; title: string; author: string; copyright: string }

const text = (d: Uint8Array) => { const end = d.indexOf(0); return new TextDecoder().decode(end < 0 ? d : d.subarray(0, end)); };

/** The header of a GBS v1 file (same checks as the core's `parse_header`), or null. */
export function parseGbsHeader(data: Uint8Array): GbsInfo | null {
  if (data.length <= 0x70 || data[0] !== 0x47 || data[1] !== 0x42 || data[2] !== 0x53 || data[3] !== 1 || !data[4]) return null;
  const load = data[6] | (data[7] << 8);
  if (load < 0x0400 || load > 0x7fff) return null;
  return { songs: data[4], first: data[5], title: text(data.subarray(0x10, 0x30)), author: text(data.subarray(0x30, 0x50)), copyright: text(data.subarray(0x50, 0x70)) };
}
