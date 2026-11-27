#!/usr/bin/env python3
"""dylds.py — list the LC_LOAD_* dylib table (and rpaths/build version) of a
Mach-O binary. Handles fat (universal) files and thin x86_64/arm64 slices.
Usage: python3 dylds.py <mach-o-path>"""
import struct
import sys

DYLIB_CMDS = {0x0C: "load", 0x18: "weak", 0x1F: "reexport", 0x20: "lazy"}
CPU = {0x01000007: "x86_64", 0x0100000C: "arm64"}


def main(path):
    f = open(path, "rb")

    def rd(off, n):
        f.seek(off)
        return f.read(n)

    def cstr(start, limit):
        f.seek(start)
        out = b""
        while True:
            c = f.read(1)
            if c == b"\x00" or not c or f.tell() > limit:
                break
            out += c
        return out.decode("utf-8", "replace")

    magic = struct.unpack(">I", rd(0, 4))[0]
    slices = []
    if magic == 0xCAFEBABE:
        n = struct.unpack(">I", rd(4, 4))[0]
        off = 8
        for _ in range(n):
            ct, cs, offset, size, al = struct.unpack(">IIIII", rd(off, 20))
            slices.append((CPU.get(ct, hex(ct)), offset))
            off += 20
    else:
        slices.append(("thin?", 0))

    for arch, base in slices:
        print("\n===== %s @0x%x =====" % (arch, base))
        m = struct.unpack("<I", rd(base, 4))[0]
        if m != 0xFEEDFACF:
            print("not MH_MAGIC_64: %s" % hex(m))
            continue
        magic, ct, csub, ftype, ncmds, sc, fl, res = struct.unpack("<IiiIIIII", rd(base, 32))
        dylibs, rpaths, build = [], [], None
        pos = base + 32
        for _ in range(ncmds):
            cmd, cmdsize = struct.unpack("<II", rd(pos, 8))
            if cmd in DYLIB_CMDS:
                noff = struct.unpack("<I", rd(pos + 8, 4))[0]
                dylibs.append((DYLIB_CMDS[cmd], cstr(pos + noff, pos + cmdsize)))
            elif cmd == 0x1C:
                off = struct.unpack("<I", rd(pos + 8, 4))[0]
                rpaths.append(cstr(pos + off, pos + cmdsize))
            elif cmd == 0x32:
                plat, minos, sdk, ntools = struct.unpack("<IIII", rd(pos + 8, 16))
                v = lambda x: "%d.%d.%d" % (x >> 16, (x >> 8) & 0xFF, x & 0xFF)
                build = (plat, v(minos), v(sdk))
            pos += cmdsize
        print("filetype=%d ncmds=%d dylibs=%d rpaths=%s" % (ftype, ncmds, len(dylibs), rpaths))
        if build:
            print("build_version: platform=%s (1=macOS) minos=%s sdk=%s" % build)
        for kind, name in dylibs:
            print("  [%s] %s" % (kind, name))


if __name__ == "__main__":
    main(sys.argv[1])
