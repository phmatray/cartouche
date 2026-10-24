//! The knowledge database: a sidecar JSON file, outside any repository, chosen by the user
//! (`--db <path>` or `GB_MCP_DB`). It holds labels, comments, a `.tbl` charmap path and far-call
//! conventions, keyed by the ROM's SHA-1 so one file can serve several ROMs.
//!
//! Several server processes (one per agent) may share the file. Every change is applied under a
//! lock file to a copy freshly reloaded from disk, then written atomically (temp file + rename),
//! so concurrent agents never lose each other's labels. Before each tool call the file is
//! reloaded if it changed, so labels set by one agent show up in every other agent's output.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{num, R};

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct DbFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub roms: BTreeMap<String, Knowledge>,
    /// Keys this version does not know (hand-written, or from a newer gb-mcp): kept on write.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Everything known about one ROM. Location keys are "BB:AAAA" (hex; bank 00 for unbanked).
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Knowledge {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, Label>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub comments: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charmap: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub far_calls: Vec<FarCall>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Label {
    pub name: String,
    /// code | data | ram | jumptable | pointers
    #[serde(default = "code")]
    pub kind: String,
    /// Bytes the region takes (data): the sweep resumes code right after it. Without it, a
    /// non-code region runs to the next label. Kept as JSON (number, or hex string by hand).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<Value>,
    /// jumptable / pointers: the number of little-endian 16-bit entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entries: Option<Value>,
    /// jumptable / pointers: the ROM bank of entries in $4000-$7FFF when it isn't the table's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_bank: Option<Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
fn code() -> String {
    "code".into()
}

fn opt(v: &Option<Value>) -> Option<u32> {
    v.as_ref().and_then(|v| num(v).ok())
}

impl Label {
    /// A declared table of 16-bit pointers: (entries, target bank if fixed).
    pub fn table(&self) -> Option<(u32, Option<u16>)> {
        if !matches!(self.kind.as_str(), "jumptable" | "pointers") {
            return None;
        }
        Some((opt(&self.entries)?, opt(&self.target_bank).map(|b| b as u16)))
    }

    /// The bytes a non-code region takes, when known: its size, else a table's entries * 2.
    pub fn size(&self) -> Option<u32> {
        opt(&self.size).or(self.table().map(|(n, _)| n.saturating_mul(2))).filter(|&n| n > 0)
    }
}

/// A declared far-call convention. `inline`: a CALL/RST to `via` is followed by inline bytes
/// laid out as `layout` (e.g. ["bank", "lo", "hi"]; "skip" for an ignored byte), and execution
/// resumes after them. `regs`: `via` takes the bank in the 8-bit register `bank_reg` and the
/// address in the pair `addr_reg`, loaded by immediates before the call
/// (e.g. `ld a, bank ; ld hl, addr ; call via`). `bank`: a fixed target bank instead of a
/// `bank` layout byte or `bank_reg`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FarCall {
    pub name: String,
    pub via: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layout: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bank_reg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addr_reg: Option<String>,
    /// A fixed target bank, for conventions that don't pass one (e.g. inline ["lo", "hi"]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bank: Option<Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

pub struct Db {
    path: Option<PathBuf>,
    file: DbFile,
    stamp: Option<(SystemTime, u64)>,
}

fn stamp(p: &Path) -> Option<(SystemTime, u64)> {
    fs::metadata(p).ok().map(|m| (m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len()))
}

fn load(p: &Path) -> R<DbFile> {
    match fs::read_to_string(p) {
        Ok(s) if s.trim().is_empty() => Ok(DbFile::default()),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("knowledge DB {}: {e}", p.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DbFile::default()),
        Err(e) => Err(format!("knowledge DB {}: {e}", p.display())),
    }
}

/// An OS lock (flock / LockFileEx) on `<db>.lock`, released when dropped or when the process
/// dies, so a crashed writer never leaves a stale lock. The file itself stays: deleting a lock
/// file another process may be opening would let two writers in.
struct Lock(#[allow(dead_code)] File);
impl Lock {
    fn take(db: &Path) -> R<Lock> {
        let p = PathBuf::from(format!("{}.lock", db.display()));
        let f = OpenOptions::new().write(true).create(true).truncate(false).open(&p).map_err(|e| format!("cannot lock {}: {e}", p.display()))?;
        let start = Instant::now();
        loop {
            match f.try_lock() {
                Ok(()) => return Ok(Lock(f)),
                Err(TryLockError::WouldBlock) if start.elapsed() < Duration::from_secs(10) => std::thread::sleep(Duration::from_millis(3)),
                Err(TryLockError::WouldBlock) => return Err(format!("knowledge DB {}: another gb-mcp held the lock for 10 s", db.display())),
                Err(TryLockError::Error(e)) => return Err(format!("cannot lock {}: {e}", p.display())),
            }
        }
    }
}

impl Db {
    /// `None`: an in-memory DB (nothing persists).
    pub fn open(path: Option<PathBuf>) -> R<Db> {
        let file = match &path {
            Some(p) => load(p)?,
            None => DbFile::default(),
        };
        let stamp = path.as_deref().and_then(stamp);
        Ok(Db { path, file, stamp })
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Reloads the file if another process changed it.
    pub fn refresh(&mut self) -> R<()> {
        let Some(p) = &self.path else { return Ok(()) };
        let now = stamp(p);
        if now != self.stamp {
            self.file = load(p)?;
            self.stamp = now;
        }
        Ok(())
    }

    pub fn file(&self) -> &DbFile {
        &self.file
    }

    pub fn knowledge(&self, sha1: &str) -> Knowledge {
        self.file.roms.get(sha1).cloned().unwrap_or_default()
    }

    /// Applies `f` to the ROM's knowledge: under the lock, on a fresh copy of the file, then
    /// written back atomically. Changes by other processes since our last read are kept.
    pub fn update<T>(&mut self, sha1: &str, f: impl FnOnce(&mut Knowledge) -> R<T>) -> R<T> {
        let Some(p) = self.path.clone() else {
            return f(self.file.roms.entry(sha1.into()).or_default());
        };
        let _lock = Lock::take(&p)?;
        let mut file = load(&p)?;
        file.version = 1;
        let out = f(file.roms.entry(sha1.into()).or_default())?;
        file.roms.retain(|_, k| *k != Knowledge::default());
        let tmp = PathBuf::from(format!("{}.tmp{}", p.display(), std::process::id()));
        let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())? + "\n";
        fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
        fs::rename(&tmp, &p).map_err(|e| format!("{}: {e}", p.display()))?;
        self.stamp = stamp(&p);
        self.file = file;
        Ok(out)
    }
}

// ---------- locations ----------

pub fn key(bank: u16, addr: u16) -> String {
    format!("{bank:02X}:{addr:04X}")
}

pub fn parse_key(k: &str) -> R<(u16, u16)> {
    let (b, a) = k.split_once(':').ok_or(format!("bad location key {k:?} (want BB:AAAA)"))?;
    let h = |s: &str| u16::from_str_radix(s.trim(), 16).map_err(|_| format!("bad location key {k:?}"));
    Ok((h(b)?, h(a)?))
}

/// Does this address sit in a banked region ($4000-$7FFF ROM, $D000-$DFFF WRAM)?
pub fn banked(addr: u16) -> bool {
    (0x4000..0x8000).contains(&addr) || (0xD000..0xE000).contains(&addr)
}

/// A far-call convention, decoded for the sweeper.
#[derive(Clone, Debug)]
pub enum Conv {
    /// layout: 0 bank, 1 lo, 2 hi, 3 skip; `bank`: fixed target bank (no bank byte)
    Inline { name: String, via: (u16, u16), layout: Vec<u8>, bank: Option<u16> },
    /// bank_reg: B C D E H L - A as 0-7; addr_pair: 0 BC, 1 DE, 2 HL; `bank`: fixed, instead of bank_reg
    Regs { name: String, via: (u16, u16), bank_reg: usize, addr_pair: usize, bank: Option<u16> },
    /// A bank-switch routine: maps the bank in `bank_reg` (or the fixed `bank`) at $4000-$7FFF,
    /// so the bank-0 calls and jumps into $4000-$7FFF that follow it resolve to that bank.
    Switch { name: String, via: (u16, u16), bank_reg: usize, bank: Option<u16> },
}
impl Conv {
    pub fn name(&self) -> &str {
        match self {
            Conv::Inline { name, .. } | Conv::Regs { name, .. } | Conv::Switch { name, .. } => name,
        }
    }
    pub fn via(&self) -> (u16, u16) {
        match self {
            Conv::Inline { via, .. } | Conv::Regs { via, .. } | Conv::Switch { via, .. } => *via,
        }
    }
}

pub fn conv(f: &FarCall) -> R<Conv> {
    let via = parse_key(&canon_key(&f.via)?)?;
    let bank = match &f.bank {
        None | Some(Value::Null) => None,
        Some(v) => Some(num(v).ok().filter(|&b| b <= 0x1FF).ok_or(format!("far call {:?}: bank {v} (want a ROM bank, hex)", f.name))? as u16),
    };
    match f.kind.as_str() {
        "inline" => {
            let layout = f
                .layout
                .iter()
                .map(|s| match s.as_str() {
                    "bank" => Ok(0),
                    "lo" => Ok(1),
                    "hi" => Ok(2),
                    "skip" => Ok(3),
                    o => Err(format!("far call {:?}: layout item {o:?} (want bank|lo|hi|skip)", f.name)),
                })
                .collect::<R<Vec<u8>>>()?;
            if !layout.contains(&1) || !layout.contains(&2) || layout.contains(&0) == bank.is_some() {
                return Err(format!("far call {:?}: layout needs lo and hi, and bank unless a fixed \"bank\" is given (not both)", f.name));
            }
            Ok(Conv::Inline { name: f.name.clone(), via, layout, bank })
        }
        "regs" | "switch" => {
            let r = f.bank_reg.as_deref().unwrap_or("a").to_ascii_lowercase();
            let bank_reg = ["b", "c", "d", "e", "h", "l", "", "a"].iter().position(|x| !x.is_empty() && *x == r)
                .ok_or(format!("far call {:?}: bank_reg {r:?} (want a|b|c|d|e|h|l)", f.name))?;
            let p = f.addr_reg.as_deref().unwrap_or("hl").to_ascii_lowercase();
            let addr_pair = ["bc", "de", "hl"].iter().position(|x| *x == p)
                .ok_or(format!("far call {:?}: addr_reg {p:?} (want bc|de|hl)", f.name))?;
            if bank.is_some() && f.bank_reg.is_some() {
                return Err(format!("far call {:?}: give a fixed \"bank\" or a \"bank_reg\", not both", f.name));
            }
            if f.kind == "switch" {
                return Ok(Conv::Switch { name: f.name.clone(), via, bank_reg, bank });
            }
            Ok(Conv::Regs { name: f.name.clone(), via, bank_reg, addr_pair, bank })
        }
        o => Err(format!("far call {:?}: kind {o:?} (want inline|regs|switch)", f.name)),
    }
}

/// "BB:AAAA" / "AAAA" -> canonical key (bank 00 where the region is unbanked).
fn canon_key(s: &str) -> R<String> {
    let (b, a) = match s.split_once(':') {
        Some((b, a)) => (Some(num(&Value::String(b.into()))? as u16), num(&Value::String(a.into()))? as u16),
        None => (None, num(&Value::String(s.into()))? as u16),
    };
    Ok(key(if banked(a) { b.ok_or(format!("{s:?}: a banked address needs BB:AAAA"))? } else { 0 }, a))
}

/// A lookup-friendly view of one ROM's knowledge, rebuilt per tool call.
#[derive(Default)]
pub struct View {
    pub labels: BTreeMap<(u16, u16), Label>,
    pub names: HashMap<String, (u16, u16)>,
    pub comments: BTreeMap<(u16, u16), String>,
    pub convs: Vec<Conv>,
    pub charmap: Option<String>,
    /// The open ROM's bank count, to refuse "BB:AAAA" in a bank that doesn't exist (0: unchecked).
    pub rom_banks: u16,
    /// Where the function at each unsized code label ends (exclusive, as `function_bounds`
    /// finds it): past it, an address is no longer shown as "Label+$off".
    pub ends: HashMap<(u16, u16), u32>,
}

impl View {
    pub fn new(k: &Knowledge) -> View {
        let mut v = View { charmap: k.charmap.clone(), ..View::default() };
        for (key, l) in &k.labels {
            if let Ok(loc) = parse_key(key) {
                v.names.insert(l.name.clone(), loc);
                v.labels.insert(loc, l.clone());
            }
        }
        v.comments = k.comments.iter().filter_map(|(key, c)| Some((parse_key(key).ok()?, c.clone()))).collect();
        // A bad convention is reported by farcall_set; one edited into the file by hand is skipped.
        v.convs = k.far_calls.iter().filter_map(|f| conv(f).ok()).collect();
        v
    }

    /// The label at this location, or the nearest one before it in the same bank as
    /// "name+$off": within its size when it has one, within its function for a code label whose
    /// extent is known, else up to $100 bytes past it.
    pub fn name(&self, bank: u16, addr: u16) -> Option<String> {
        let ((b, a), l) = self.labels.range(..=(bank, addr)).next_back()?;
        if *b != bank {
            return None; // checked first: a label in a lower bank may sit above addr
        }
        let off = addr - a;
        let same_region = (*a < 0x4000) == (addr < 0x4000) && (*a < 0x8000) == (addr < 0x8000);
        let end = match (l.size(), self.ends.get(&(*b, *a))) {
            // Past a sized region (a table), the bytes are no longer part of it.
            (Some(n), _) => *a as u32 + n,
            // Past the function's last instruction, another routine (or data) starts.
            (None, Some(&e)) if l.kind == "code" => e.max(*a as u32 + 1),
            _ => *a as u32 + 0x101,
        };
        if !same_region || addr as u32 >= end {
            return None;
        }
        Some(if off == 0 { l.name.clone() } else { format!("{}+${off:X}", l.name) })
    }

    /// "BB:AAAA" plus " name" only for a label exactly there (for targets, which are entries).
    pub fn fmt_exact(&self, bank: u16, addr: u16) -> String {
        match self.exact(bank, addr) {
            Some(n) => format!("{bank:02X}:{addr:04X} {n}"),
            None => format!("{bank:02X}:{addr:04X}"),
        }
    }

    pub fn exact(&self, bank: u16, addr: u16) -> Option<&str> {
        self.labels.get(&(bank, addr)).map(|l| l.name.as_str())
    }

    /// "BB:AAAA" plus " name" when a label covers it.
    pub fn fmt(&self, bank: u16, addr: u16) -> String {
        match self.name(bank, addr) {
            Some(n) => format!("{bank:02X}:{addr:04X} {n}"),
            None => format!("{bank:02X}:{addr:04X}"),
        }
    }

    /// A location argument: a label name, "BB:AAAA", or a plain address (JSON number = decimal,
    /// string = hex). Anything after a space is ignored, so "00:1A2B Name" from any output
    /// works as input. Returns (bank if known, addr); the bank is always known below $4000.
    pub fn loc(&self, v: &Value) -> R<(Option<u16>, u16)> {
        let (b, a) = match v {
            Value::String(s) => {
                let s = s.trim();
                if let Some(&(b, a)) = self.names.get(s) {
                    return Ok((Some(b), a));
                }
                let first = s.split_whitespace().next().unwrap_or("");
                match first.split_once(':') {
                    Some((b, a)) => (Some(num(&Value::String(b.into()))?), num(&Value::String(a.into()))?),
                    None => (None, num(&Value::String(first.into())).map_err(|_| format!("unknown label or address {s:?}"))?),
                }
            }
            _ => (None, num(v)?),
        };
        let a = u16::try_from(a).map_err(|_| format!("{v}: address ${a:X} is above $FFFF"))?;
        if !banked(a) {
            return Ok((Some(0), a));
        }
        let Some(b) = b else { return Ok((None, a)) };
        if b == 0 && a < 0x8000 {
            return Err(format!("{v}: bank 00 is the fixed $0000-$3FFF; $4000-$7FFF holds a switchable bank (01 and up): give that bank, or a plain address for the bank mapped now"));
        }
        let (what, n) = if a < 0x8000 { ("ROM", self.rom_banks as u32) } else { ("WRAM", 8) };
        if n > 0 && b >= n {
            return Err(format!("{v}: no {what} bank {b:02X} (banks 00-{:02X})", n - 1));
        }
        Ok((Some(b as u16), a))
    }
}
