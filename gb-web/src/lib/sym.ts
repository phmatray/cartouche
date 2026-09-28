/** RGBDS symbol files (`rgblink -n game.sym`): `BB:AAAA Name` lines, `;` comments. Held in memory for the session. */
export interface Sym { bank: number; addr: number; name: string }
export interface SymTable { byName: Map<string, Sym>; byAddr: Map<number, Sym[]>; skipped: number }

const LINE = /^([0-9a-f]{1,2}):([0-9a-f]{4})\s+(\S+)$/i;

export function parseSym(text: string): SymTable {
  const t: SymTable = { byName: new Map(), byAddr: new Map(), skipped: 0 };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*/, '').trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (!m) { t.skipped++; continue; }
    const sym = { bank: parseInt(m[1], 16), addr: parseInt(m[2], 16), name: m[3] };
    t.byName.set(sym.name, sym);
    const at = t.byAddr.get(sym.addr);
    if (at) at.push(sym); else t.byAddr.set(sym.addr, [sym]);
  }
  return t;
}

/** The label for `addr` as the CPU sees it now: bank 0 for $0000-$3FFF, `romBank` for $4000-$7FFF, WRAM/HRAM as listed. */
export function labelAt(t: SymTable, addr: number, romBank: number): string | undefined {
  const syms = t.byAddr.get(addr);
  if (!syms) return undefined;
  if (addr < 0x4000) return syms.find((s) => s.bank === 0)?.name;
  if (addr < 0x8000) return syms.find((s) => s.bank === romBank)?.name;
  return syms[0].name;
}

/** Replace `$XXXX` operands in a disassembly line with labels when one matches. */
export function withLabels(t: SymTable, text: string, romBank: number): string {
  return text.replace(/\$([0-9A-F]{4})\b/gi, (hex, a: string) => labelAt(t, parseInt(a, 16), romBank) ?? hex);
}

/** "Main", "Main.loop", or "$0150"/"0150". */
export function resolve(t: SymTable, input: string): number | undefined {
  const s = input.trim();
  const sym = t.byName.get(s);
  if (sym) return sym.addr;
  const m = /^\$?([0-9a-f]{1,4})$/i.exec(s);
  return m ? parseInt(m[1], 16) : undefined;
}
