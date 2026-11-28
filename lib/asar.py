#!/usr/bin/env python3
"""Read Electron .asar archives, stdlib only (read-only).

Used by lAInux recipes to pull single files (e.g. the app icon) out of an
upstream app.asar without installing npm tooling. Nothing is ever written into
an archive.

Layout (little endian):
  u32 4                      size of the next field
  u32 header_pickle_size
  header pickle: u32 payload_size, u32 json_len, json bytes (padded to 4)
  file data starts at 8 + header_pickle_size; each file entry carries
  {"size": n, "offset": "<decimal string>"} relative to that point, or
  {"unpacked": true} when it lives in <archive>.unpacked/.

  asar.py --list ARCHIVE
  asar.py --extract ARCHIVE PATH_IN_ARCHIVE OUT_FILE
"""
import json
import os
import struct
import sys


class AsarError(ValueError):
    pass


def read_header(f):
    head = f.read(16)
    if len(head) < 16:
        raise AsarError("truncated asar header")
    four, pickle_size, _payload, json_len = struct.unpack("<4I", head)
    if four != 4 or json_len > pickle_size or pickle_size > 64 << 20:
        raise AsarError("not an asar archive")
    try:
        header = json.loads(f.read(json_len))
    except ValueError as e:
        raise AsarError(f"bad asar header json: {e}") from None
    return header, 8 + pickle_size


def walk(node, prefix=""):
    for name, ent in node.get("files", {}).items():
        path = f"{prefix}{name}"
        if "files" in ent:
            yield from walk(ent, path + "/")
        else:
            yield path, ent


def find(header, path):
    node = header
    parts = [p for p in path.split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        raise AsarError(f"invalid path: {path!r}")
    for p in parts:
        node = node.get("files", {}).get(p)
        if node is None:
            raise AsarError(f"not in archive: {path}")
    if "files" in node:
        raise AsarError(f"is a directory: {path}")
    return node


def read_file(archive, path):
    with open(archive, "rb") as f:
        header, base = read_header(f)
        ent = find(header, path)
        if ent.get("unpacked"):
            with open(os.path.join(archive + ".unpacked", *path.split("/")), "rb") as u:
                return u.read()
        size, off = int(ent["size"]), int(ent["offset"])
        f.seek(base + off)
        data = f.read(size)
        if len(data) != size:
            raise AsarError(f"truncated data for {path}")
        return data


def main(argv):
    if len(argv) == 2 and argv[0] == "--list":
        with open(argv[1], "rb") as f:
            header, _ = read_header(f)
        for path, ent in walk(header):
            print(f"{ent.get('size', 0)}\t{'U' if ent.get('unpacked') else '-'}\t{path}")
        return 0
    if len(argv) == 4 and argv[0] == "--extract":
        data = read_file(argv[1], argv[2])
        os.makedirs(os.path.dirname(os.path.abspath(argv[3])), exist_ok=True)
        with open(argv[3], "wb") as o:
            o.write(data)
        return 0
    print((__doc__ or "").split("\n\n")[-1], file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (AsarError, OSError) as e:
        print(f"asar: {e}", file=sys.stderr)
        sys.exit(1)
