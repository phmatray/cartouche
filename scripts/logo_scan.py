#!/usr/bin/env python3
"""Finds a 48-byte pattern (the Nintendo logo, known here only by its SHA-1) in files, raw or disguised.

Usage: git ls-files --eol -z | logo_scan.py
                                     prints each path (but *.gb/*.gbc) that holds the logo, or is an archive (by its
                                     magic bytes, whatever its name: a ROM can hide in one)
       logo_scan.py --self-test      checks the decoders on a synthetic pattern (no logo bytes involved)

A binary file is scanned as raw bytes. A text file is also scanned for byte arrays written out in source
(0xCE, 0xED, ... / 0xce_u8 ... / $CE $ED ... / CE ED ... / CEED... / 206, 237, ... / \\xCE\\xED..., with // and /* */
comments between items), for hex dumps (xxd, xxd -p, hexdump -C, od, Intel HEX), for uuencode and for base64 runs,
wrapped over several lines or not (a ROM inside a backup, a data: URL, PEM/MIME output), each decoded to bytes first.
What decodes is checked like a file of its own (an archive, say a gzipped ROM in base64, fails too), and scanned as
text once more. A zlib or LZMA stream counts as an archive.
"""
import base64
import binascii
import gzip
import hashlib
import lzma
import os
import re
import sys
import zlib

LOGO_SHA1 = "0745fdef34132d1b3d488cfbdf0379a39fd54b4c"
N = 48

HEX_RUN = re.compile(rb"(?:(?:0[xX]|\$)[0-9a-fA-F]{1,2}(?:_?[uU]8)?[\s,]*){48,}")
BARE_HEX_RUN = re.compile(rb"(?:\b[0-9a-fA-F]{2}\b[\s,]*){48,}")
# A hex string with no separators (Buffer.from("ceed...", "hex")), read at both byte alignments.
HEX_STR = re.compile(rb"[0-9a-fA-F]{96,}")
DEC_RUN = re.compile(rb"(?:\b\d{1,3}\b\s*,\s*){47,}\b\d{1,3}\b")
ESC_RUN = re.compile(rb"(?:\\x[0-9a-fA-F]{2}[\s\"'`+]*){48,}")
# One line of 40+ characters, then the lines it wraps onto (base64 -b 60, openssl, MIME: any wrap width).
B64_RUN = re.compile(rb"[A-Za-z0-9+/]{40,}(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9+/]{4,})*={0,2}")
# Full uuencoded lines ("M" = 45 bytes, then 60 characters).
UU_RUN = re.compile(rb"(?:^M[\x20-\x60]{60}\r?\n)+", re.M)
# A dump line's leading address (xxd "00000100:", hexdump -C "00000100"): 6+ hex digits, then a blank.
DUMP_ADDR = re.compile(rb"^\s*[0-9a-fA-F]{6,}:?(?=\s)")
# An Intel HEX data record: ":LLAAAA00<data>CC".
IHEX = re.compile(rb"^:[0-9a-fA-F]{8}([0-9a-fA-F]*)[0-9a-fA-F]{2}\s*$")
# Source comments, dropped before reading byte arrays (a URL's :// is not one; base64 runs are read unstripped).
COMMENT = re.compile(rb"(?<!:)//[^\n]*|/\*.*?\*/", re.S)
# zip, gzip, 7z, xz, zstd, bzip2, rar. zlib and LZMA streams, whose first bytes are not unique, are decoded in archive();
# brotli has no header at all (check-no-game-data.sh bans .br by name).
ARCHIVE = re.compile(rb"PK\x03\x04|PK\x05\x06|\x1f\x8b\x08|7z\xbc\xaf\x27\x1c|\xfd7zXZ\x00|\x28\xb5\x2f\xfd|BZh[1-9]1AY&SY|Rar!\x1a\x07")


def dump(text):
    """The bytes of a hex dump, whatever its layout (xxd, xxd -p, hexdump -C, od, Intel HEX): each line's address
    dropped, then its hex tokens read up to the first word that is not one (the ASCII column), lines joined."""
    out = bytearray()
    for line in text.splitlines():
        m = IHEX.match(line)
        if m:
            h = m.group(1)
        else:
            h = b""
            for tok in DUMP_ADDR.sub(b"", line).split():
                if len(tok) % 2 or re.fullmatch(rb"[0-9a-fA-F]+", tok) is None:
                    break  # ponytail: an ASCII column made only of hex letters reads as data; the run then breaks there
                h += tok
        if len(h) % 2 == 0:
            out += bytes.fromhex(h.decode())
    return bytes(out)


def has(d, digest):
    return any(hashlib.sha1(d[i:i + N]).hexdigest() == digest for i in range(len(d) - N + 1))


def decoded(text):
    """Byte strings a text file could be hiding: written-out byte arrays and base64 runs."""
    for m in B64_RUN.finditer(text):
        run = re.sub(rb"\s", b"", m.group()).rstrip(b"=")
        try:
            yield base64.b64decode(run[: len(run) // 4 * 4], validate=True)
        except binascii.Error:
            pass
    for m in UU_RUN.finditer(text):
        yield b"".join(binascii.a2b_uu(line) for line in m.group().splitlines())
    yield dump(text)
    text = COMMENT.sub(b" ", text)
    for m in ESC_RUN.finditer(text):
        yield bytes(int(t, 16) for t in re.findall(rb"\\x([0-9a-fA-F]{2})", m.group()))
    for m in HEX_RUN.finditer(text):
        yield bytes(int(t, 16) for t in re.findall(rb"(?:0[xX]|\$)([0-9a-fA-F]{1,2})", m.group()))
    for m in BARE_HEX_RUN.finditer(text):
        yield bytes(int(t, 16) for t in re.findall(rb"\b[0-9a-fA-F]{2}\b", m.group()))
    for m in HEX_STR.finditer(text):
        for i in (0, 1):
            run = m.group()[i:]
            yield bytes.fromhex(run[: len(run) // 2 * 2].decode())
    for m in DEC_RUN.finditer(text):
        yield bytes(v for v in map(int, re.findall(rb"\d+", m.group())) if v < 256)


def inflates(d, fmt):
    """d starts a stream lzma (fmt) or zlib (fmt None) decodes: a header alone could be any binary's first bytes."""
    try:
        z = lzma.LZMADecompressor(fmt) if fmt else zlib.decompressobj()
        return len(z.decompress(d[:65536], 4096)) > 0
    except (lzma.LZMAError, zlib.error):
        return False


def archive(d):
    return (ARCHIVE.match(d) is not None
            or (d[:1] == b"\x78" and len(d) > 1 and (d[0] << 8 | d[1]) % 31 == 0 and inflates(d, None))
            or (d[:3] == b"\x5d\x00\x00" and inflates(d, lzma.FORMAT_ALONE)))


def holds(d, text, digest=LOGO_SHA1, depth=2):
    """The logo is in d, raw or (text) written out; what a text decodes to also fails for being an archive."""
    return has(d, digest) or (text and depth > 0 and any(archive(b) or holds(b, True, digest, depth - 1) for b in decoded(d)))


def self_test():
    pat = bytes((i * 37 + 11) % 256 for i in range(N))
    dig = hashlib.sha1(pat).hexdigest()
    rom = bytes(0x104) + pat + bytes(200)
    cases = {
        "raw": (b"xx" + pat, False),
        "c hex": (b"const u8 L[] = {" + b", ".join(b"0x%02X" % v for v in pat) + b"};", True),
        "rust u8": (b"[" + b",".join(b"0x%02xu8" % v for v in pat) + b"]", True),
        "rust _u8": (b"[" + b", ".join(b"0x%02x_u8" % v for v in pat) + b"]", True),
        "hex string": (b'Buffer.from("' + rom.hex().encode() + b'", "hex")', True),
        "hex string, odd offset": (b"x0" + rom.hex().encode(), True),
        "gzip in base64": (b'{"rom":"' + base64.b64encode(gzip.compress(bytes(i * i % 251 for i in range(4000)))) + b'"}', True),
        "hex in base64": (base64.b64encode(b" ".join(b"%02x" % v for v in pat) + b"\n\n"), True),
        "asm $": (b"db " + b",".join(b"$%02X" % v for v in pat), True),
        "hex dump": (b" ".join(b"%02x" % v for v in pat), True),
        "decimal": (b"[" + b", ".join(b"%d" % v for v in pat) + b"]", True),
        "base64": (b'{"$b64":"' + base64.b64encode(rom) + b'"}', True),
        "base64 +1": (b"data:;base64," + base64.b64encode(b"\0" + rom), True),
        "base64 wrapped": (base64.encodebytes(bytes(3) + rom), True),
        "base64 crlf": (base64.encodebytes(rom).replace(b"\n", b"\r\n"), True),
        "x escapes": (b'const s = "' + b"".join(b"\\x%02x" % v for v in pat[:30]) + b'" +\n  "'
                      + b"".join(b"\\x%02x" % v for v in pat[30:]) + b'";', True),
        "c hex, comments": (b"{\n" + b"".join(b"  " + b", ".join(b"0x%02X" % v for v in pat[i:i + 16]) + b", // row %d 0x10\n" % i
                                            for i in range(0, N, 16)) + b"/* end */}", True),
        "xxd": (b"".join(b"%08x: " % i + b" ".join(rom[j:j + 2].hex().encode() for j in range(i, i + 16, 2))
                         + b"  ..ab.f....\n" for i in range(0, len(rom) - 15, 16)), True),
        "xxd -p": (b"\n".join(rom.hex().encode()[i:i + 60] for i in range(0, 2 * len(rom), 60)), True),
        "hexdump -C": (b"".join(b"%08x  " % i + b" ".join(b"%02x" % v for v in rom[i:i + 8]) + b"  "
                                + b" ".join(b"%02x" % v for v in rom[i + 8:i + 16]) + b"  |..P.ff|\n"
                                for i in range(0, len(rom), 16)), True),
        "intel hex": (b"".join(b":%02X%04X00%s00\n" % (len(rom[i:i + 16]), i, rom[i:i + 16].hex().upper().encode())
                               for i in range(0, len(rom), 16)) + b":00000001FF\n", True),
        "uuencode": (b"begin 644 x\n" + b"".join(binascii.b2a_uu(rom[i:i + 45]) for i in range(0, len(rom), 45))
                     + b"`\nend\n", True),
        "base64 60": (b"\n".join(base64.b64encode(rom)[i:i + 60] for i in range(0, 700, 60)), True),
        "hex dump, comments": (b"\n".join(b" ".join(b"%02x" % v for v in pat[i:i + 8]) + b" /* 10 */" for i in range(0, N, 8)), True),
    }
    for name, (data, text) in cases.items():
        assert holds(data, text, dig), name
    assert not holds(b"0x01, " * 100, True, dig), "false positive"
    assert not holds(b"0123456789abcdef" * 20, True, dig), "hex false positive"
    for magic in (b"PK\x03\x04", b"\x1f\x8b\x08", b"BZh91AY&SY", b"\xfd7zXZ\x00"):
        assert archive(magic + bytes(20)), magic
    assert archive(zlib.compress(rom)) and archive(lzma.compress(rom, format=lzma.FORMAT_ALONE)), "zlib / lzma"
    assert not archive(b"\x78\x9c not zlib") and not archive(b"\x5d\x00\x00 not lzma"), "stream false positive"
    assert not archive(b"BZh? not bzip2") and not archive(b"\x89PNG\r\n\x1a\n"), "archive false positive"
    print("logo_scan self-test OK")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        sys.exit(0)
    # NUL-separated "i/<eol> w/<eol> attr/<attr>\t<path>" records: a path is never quoted, whatever its characters.
    for rec in sys.stdin.buffer.read().split(b"\0"):
        if not rec:
            continue
        info, path = rec.split(b"\t", 1)
        if path.endswith((b".gb", b".gbc")):
            continue  # the bundled ROMs (a banned name anywhere else), whose headers need the logo
        text, path = not info.startswith(b"i/-text"), os.fsdecode(path)
        d = open(path, "rb").read()
        if archive(d):
            print(path + " (an archive)")
        elif holds(d, text):
            print(path)
