#!/usr/bin/env python3
"""Finds a 48-byte pattern (the Nintendo logo, known here only by its SHA-1) in files, raw or disguised.

Usage: logo_scan.py < paths          prints each path that holds the logo, or is an archive (by its magic bytes,
                                     whatever its name: a ROM can hide in one)
       logo_scan.py --self-test      checks the decoders on a synthetic pattern (no logo bytes involved)

A binary file is scanned as raw bytes. A text file is also scanned for byte arrays written out in source
(0xCE, 0xED, ... / $CE $ED ... / CE ED ... / 206, 237, ... / \\xCE\\xED..., with // and /* */ comments between
items) and for base64 runs, wrapped over several lines or not (a ROM inside a backup, a data: URL, PEM/MIME output),
each decoded to bytes first.
"""
import base64
import binascii
import hashlib
import re
import sys

LOGO_SHA1 = "0745fdef34132d1b3d488cfbdf0379a39fd54b4c"
N = 48

HEX_RUN = re.compile(rb"(?:(?:0[xX]|\$)[0-9a-fA-F]{1,2}(?:[uU]8)?[\s,]*){48,}")
BARE_HEX_RUN = re.compile(rb"(?:\b[0-9a-fA-F]{2}\b[\s,]*){48,}")
DEC_RUN = re.compile(rb"(?:\b\d{1,3}\b\s*,\s*){47,}\b\d{1,3}\b")
ESC_RUN = re.compile(rb"(?:\\x[0-9a-fA-F]{2}[\s\"'`+]*){48,}")
# One line of 64+ characters, then the lines it wraps onto.
B64_RUN = re.compile(rb"[A-Za-z0-9+/]{64,}(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9+/]{4,})*={0,2}")
# Source comments, dropped before reading byte arrays (a URL's :// is not one; base64 runs are read unstripped).
COMMENT = re.compile(rb"(?<!:)//[^\n]*|/\*.*?\*/", re.S)
# zip, gzip, 7z, xz, zstd, bzip2, rar.
ARCHIVE = re.compile(rb"PK\x03\x04|PK\x05\x06|\x1f\x8b|7z\xbc\xaf\x27\x1c|\xfd7zXZ\x00|\x28\xb5\x2f\xfd|BZh[1-9]1AY&SY|Rar!\x1a\x07")


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
    text = COMMENT.sub(b" ", text)
    for m in ESC_RUN.finditer(text):
        yield bytes(int(t, 16) for t in re.findall(rb"\\x([0-9a-fA-F]{2})", m.group()))
    for m in HEX_RUN.finditer(text):
        yield bytes(int(t, 16) for t in re.findall(rb"(?:0[xX]|\$)([0-9a-fA-F]{1,2})", m.group()))
    for m in BARE_HEX_RUN.finditer(text):
        yield bytes(int(t, 16) for t in re.findall(rb"\b[0-9a-fA-F]{2}\b", m.group()))
    for m in DEC_RUN.finditer(text):
        yield bytes(v for v in map(int, re.findall(rb"\d+", m.group())) if v < 256)


def archive(d):
    return ARCHIVE.match(d) is not None


def holds(d, text, digest=LOGO_SHA1):
    return has(d, digest) or (text and any(has(b, digest) for b in decoded(d)))


def self_test():
    pat = bytes((i * 37 + 11) % 256 for i in range(N))
    dig = hashlib.sha1(pat).hexdigest()
    rom = bytes(0x104) + pat + bytes(200)
    cases = {
        "raw": (b"xx" + pat, False),
        "c hex": (b"const u8 L[] = {" + b", ".join(b"0x%02X" % v for v in pat) + b"};", True),
        "rust u8": (b"[" + b",".join(b"0x%02xu8" % v for v in pat) + b"]", True),
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
        "hex dump, comments": (b"\n".join(b" ".join(b"%02x" % v for v in pat[i:i + 8]) + b" /* 10 */" for i in range(0, N, 8)), True),
    }
    for name, (data, text) in cases.items():
        assert holds(data, text, dig), name
    assert not holds(b"0x01, " * 100, True, dig), "false positive"
    for magic in (b"PK\x03\x04", b"\x1f\x8b\x08", b"BZh91AY&SY", b"\xfd7zXZ\x00"):
        assert archive(magic + bytes(20)), magic
    assert not archive(b"BZh? not bzip2") and not archive(b"\x89PNG\r\n\x1a\n"), "archive false positive"
    print("logo_scan self-test OK")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        sys.exit(0)
    for line in sys.stdin.read().splitlines():
        text, path = line.split("\t", 1)
        d = open(path, "rb").read()
        if archive(d):
            print(path + " (an archive)")
        elif holds(d, text == "1"):
            print(path)
