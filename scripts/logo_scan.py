#!/usr/bin/env python3
"""Finds a 48-byte pattern (the Nintendo logo, known here only by its SHA-1) in files, raw or disguised.

Usage: logo_scan.py < paths          prints each path that holds the logo
       logo_scan.py --self-test      checks the decoders on a synthetic pattern (no logo bytes involved)

A binary file is scanned as raw bytes. A text file is also scanned for byte arrays written out in source
(0xCE, 0xED, ... / $CE $ED ... / CE ED ... / 206, 237, ...) and for base64 runs (a ROM inside a backup or a
data: URL), each decoded to bytes first.
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
B64_RUN = re.compile(rb"[A-Za-z0-9+/]{64,}={0,2}")


def has(d, digest):
    return any(hashlib.sha1(d[i:i + N]).hexdigest() == digest for i in range(len(d) - N + 1))


def decoded(text):
    """Byte strings a text file could be hiding: written-out byte arrays and base64 runs."""
    for m in HEX_RUN.finditer(text):
        yield bytes(int(t, 16) for t in re.findall(rb"(?:0[xX]|\$)([0-9a-fA-F]{1,2})", m.group()))
    for m in BARE_HEX_RUN.finditer(text):
        yield bytes(int(t, 16) for t in re.findall(rb"\b[0-9a-fA-F]{2}\b", m.group()))
    for m in DEC_RUN.finditer(text):
        yield bytes(v for v in map(int, re.findall(rb"\d+", m.group())) if v < 256)
    for m in B64_RUN.finditer(text):
        run = m.group().rstrip(b"=")
        try:
            yield base64.b64decode(run[: len(run) // 4 * 4], validate=True)
        except binascii.Error:
            pass


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
    }
    for name, (data, text) in cases.items():
        assert holds(data, text, dig), name
    assert not holds(b"0x01, " * 100, True, dig), "false positive"
    print("logo_scan self-test OK")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        sys.exit(0)
    for line in sys.stdin.read().splitlines():
        text, path = line.split("\t", 1)
        if holds(open(path, "rb").read(), text == "1"):
            print(path)
