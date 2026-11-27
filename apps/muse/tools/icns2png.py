#!/usr/bin/env python3
"""Extract the largest PNG representation from a macOS .icns icon file.
Usage: python3 icns2png.py AppIcon.icns out.png"""
import struct
import sys


def main(src, dst):
    data = open(src, "rb").read()
    if data[:4] != b"icns":
        sys.exit("not an icns file")
    total = struct.unpack(">I", data[4:8])[0]
    pos, best = 8, None
    while pos + 8 <= min(total, len(data)):
        clen = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        if clen < 8:
            break
        payload = data[pos + 8:pos + clen]
        if payload[:8] == b"\x89PNG\r\n\x1a\n":
            w, h = struct.unpack(">II", payload[16:24])
            if best is None or w * h > best[0]:
                best = (w * h, w, h, payload)
        pos += clen
    if not best:
        sys.exit("no PNG representation found in icns")
    _, w, h, payload = best
    with open(dst, "wb") as f:
        f.write(payload)
    print("icon: %dx%d -> %s" % (w, h, dst))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
